package library

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

const fileRotationSQL = `COALESCE((SELECT json_extract(d.detail,'$.rotation') FROM decisions d WHERE d.id='rotation:'||files.hash AND d.action='rotation'),0)`

func rotationSQL(hash string) string {
	return `COALESCE((SELECT json_extract(d.detail,'$.rotation') FROM decisions d WHERE d.id='rotation:'||` + hash + ` AND d.action='rotation'),0)`
}

var errRotationConflict = errors.New("照片方向或资源已改变，请刷新后重试")
var errRotationNotReady = errors.New("预览尚未就绪，请处理完成后再旋转")

func validRotation(rotation int) bool {
	return rotation == 0 || rotation == 90 || rotation == 180 || rotation == 270
}

func (l *Library) rotate(w http.ResponseWriter, r *http.Request) {
	var p struct {
		Hash             string `json:"hash"`
		Rotation         *int   `json:"rotation"`
		ExpectedRotation *int   `json:"expectedRotation"`
	}
	if !decode(w, r, &p) {
		return
	}
	id := chi.URLParam(r, "id")
	if !validID.MatchString(id) || !validHash.MatchString(p.Hash) || p.Rotation == nil || p.ExpectedRotation == nil || !validRotation(*p.Rotation) || !validRotation(*p.ExpectedRotation) {
		fail(w, 400, "请选择有效资源和 0、90、180 或 270 度方向")
		return
	}
	if err := l.saveRotation(r.Context(), id, p.Hash, *p.Rotation, *p.ExpectedRotation); err != nil {
		var pending *pendingDeletion
		switch {
		case errors.As(err, &pending):
			assetDeletionFailure(w, pending.request)
		case deletedFailure(w, err):
		case errors.Is(err, sql.ErrNoRows):
			fail(w, 404, "照片或资源不存在")
		case errors.Is(err, errRotationConflict), errors.Is(err, errRotationNotReady):
			fail(w, 409, err)
		default:
			fail(w, 500, err)
		}
		return
	}
	l.detail(w, r)
}

// Match the selected version's native motion, not an arbitrary video in its group.
func rotationTargets(files []File, hash string) []File {
	var selected File
	for _, file := range files {
		if file.Hash == hash {
			selected = file
			break
		}
	}
	if selected.Hash == "" {
		return nil
	}
	result := []File{selected}
	if !strings.HasPrefix(selected.Mime, "image/") {
		return result
	}
	role := ""
	switch selected.Hints.ResourceType {
	case "originalPhoto":
		role = "originalPairedVideo"
	case "fullSizePhoto":
		role = "fullSizePairedVideo"
	}
	paired := []File{}
	for _, file := range files {
		if !strings.HasPrefix(file.Mime, "video/") {
			continue
		}
		if selected.ContentID != "" && file.ContentID == selected.ContentID || selected.ContentID == "" && selected.Hints.SourceKey != "" && role != "" && file.Hints.SourceKey == selected.Hints.SourceKey && file.Hints.ResourceType == role {
			paired = append(paired, file)
		}
	}
	if len(paired) == 1 {
		result = append(result, paired[0])
	}
	return result
}

func checkRotationTargets(q queryer, id string, previous, current []File) error {
	request, err := assetDeletion(q, id)
	if err != nil {
		return err
	}
	if request != "" {
		return &pendingDeletion{request: request}
	}
	if len(current) == 0 {
		return sql.ErrNoRows
	}
	if len(previous) != len(current) {
		return errRotationConflict
	}
	for i, file := range current {
		if err := originalDeletion(q, file.Hash, ""); err != nil {
			return err
		}
		if file.Hash != previous[i].Hash || file.Rotation != previous[i].Rotation {
			return errRotationConflict
		}
		if file.Status != "ready" || !strings.HasPrefix(file.Mime, "image/") && !strings.HasPrefix(file.Mime, "video/") {
			return errRotationNotReady
		}
	}
	return nil
}

func (l *Library) saveRotation(ctx context.Context, id, hash string, rotation, expected int) error {
	files, err := l.Files(id)
	if err != nil {
		return err
	}
	targets := rotationTargets(files, hash)
	if len(targets) == 0 {
		return sql.ErrNoRows
	}
	if targets[0].Rotation != expected {
		return errRotationConflict
	}
	hashes := []string{}
	for _, file := range targets {
		hashes = append(hashes, file.Hash)
	}
	sort.Strings(hashes)
	unlocks := []func(){}
	for _, hash := range hashes {
		unlocks = append(unlocks, l.lockUpload(hash))
	}
	defer func() {
		for i := len(unlocks) - 1; i >= 0; i-- {
			unlocks[i]()
		}
	}()
	files, err = l.Files(id)
	if err != nil {
		return err
	}
	if err = checkRotationTargets(l.DB, id, targets, rotationTargets(files, hash)); err != nil {
		return err
	}
	if rotation == expected {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	for _, file := range targets {
		if file.Cover != nil && (!readyDerivative(l.coverPath(file, "preview")) || !readyDerivative(l.coverPath(file, "thumb"))) {
			var finish func()
			ctx, finish, err = l.beginFrameWork(ctx, targets)
			if err != nil {
				return err
			}
			defer finish()
			break
		}
	}
	rotations := make([]int, len(targets))
	for i, file := range targets {
		rotations[i] = (file.Rotation + rotation - expected + 360) % 360
		kinds := []string{"thumb", "preview"}
		if strings.HasPrefix(file.Mime, "video/") {
			kinds = []string{"thumb"}
			if file.Cover != nil {
				kinds = append(kinds, "preview")
			}
		}
		for _, kind := range kinds {
			if _, err = l.rotatedDerivative(ctx, file, kind, rotations[i]); err != nil {
				return err
			}
		}
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	tx, err := l.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	files, err = filesForAsset(tx, id)
	if err != nil {
		return err
	}
	if err = checkRotationTargets(tx, id, targets, rotationTargets(files, hash)); err != nil {
		return err
	}
	for i, file := range targets {
		detail := marshal(map[string]any{"hash": file.Hash, "rotation": rotations[i]})
		if _, err = tx.Exec(`INSERT INTO decisions(id,action,detail,created_at) VALUES(?,'rotation',?,?)
 ON CONFLICT(id) DO UPDATE SET detail=excluded.detail,created_at=excluded.created_at`, "rotation:"+file.Hash, detail, now()); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func derivativeSuffix(kind string) string {
	return "-" + kind + ".jpg"
}

func (l *Library) rotationPath(hash, kind string, rotation int) string {
	return l.Derived(hash, fmt.Sprintf("-rotation%d%s", rotation, derivativeSuffix(kind)))
}

// JPEG variants retain compressed pixels from unedited derivatives.
// Canonical fingerprints remain source-derived.
// The caller holds the original lock, excluding new processing attempts and
// permanent cleanup; save also rechecks the durable processing state.
func (l *Library) rotatedDerivative(ctx context.Context, file File, kind string, rotation int) (string, error) {
	base := l.Derived(file.Hash, derivativeSuffix(kind))
	cover := file.Cover != nil && (kind == "thumb" || kind == "preview")
	if cover {
		if err := originalDeletion(l.DB, file.Cover.Motion, ""); err != nil {
			return "", err
		}
		if err := l.generateCover(ctx, file); err != nil {
			return "", err
		}
		base = l.coverPath(file, kind)
	}
	stat, err := os.Stat(base)
	if err != nil {
		return "", err
	}
	if !stat.Mode().IsRegular() || stat.Size() == 0 {
		return "", errRotationNotReady
	}
	if rotation == 0 {
		return base, nil
	}
	path := l.rotationPath(file.Hash, kind, rotation)
	if cover {
		path = l.Derived(file.Hash, fmt.Sprintf("-cover-%s-rotation%d%s", file.Cover.Revision, rotation, derivativeSuffix(kind)))
	}
	stamp := fmt.Sprintf("%d:%d", stat.Size(), stat.ModTime().UnixNano())
	if previous, err := os.ReadFile(path + ".source"); err == nil && string(previous) == stamp {
		if ready, err := os.Stat(path); err == nil && ready.Mode().IsRegular() && ready.Size() > 0 {
			return path, nil
		}
	}
	if file.Status != "ready" {
		return "", errRotationNotReady
	}
	work, err := os.MkdirTemp(filepath.Join(l.Root, "work"), file.Hash+"-rotation-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(work)
	output := filepath.Join(work, "rotated"+filepath.Ext(base))
	err = copyRotationImage(base, output)
	if err == nil {
		orientation := map[int]string{90: "6", 180: "3", 270: "8"}[rotation]
		_, err = l.command(ctx, "exiftool", "-n", "-EXIF:Orientation="+orientation, "-overwrite_original", output)
	}
	if err != nil {
		return "", err
	}
	if err = ctx.Err(); err != nil {
		return "", err
	}
	if err = originalDeletion(l.DB, file.Hash, ""); err != nil {
		return "", err
	}
	if err = os.Chmod(output, 0600); err != nil {
		return "", err
	}
	marker := filepath.Join(work, "source")
	if err = os.WriteFile(marker, []byte(stamp), 0600); err != nil {
		return "", err
	}
	if err = os.Rename(output, path); err != nil {
		return "", err
	}
	if err = os.Rename(marker, path+".source"); err != nil {
		return "", err
	}
	return path, nil
}

func copyRotationImage(source, output string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	file, err := os.OpenFile(output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = io.Copy(file, input)
	closeErr := file.Close()
	if err != nil {
		return err
	}
	return closeErr
}

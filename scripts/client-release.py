#!/usr/bin/env python3
"""Version, verify and publish Aura's Mac DMG and unsigned iOS device IPA."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import struct
import subprocess
import tempfile
import zipfile

REPOSITORY = "Crashmere/Aura"
ROOT = Path(__file__).resolve().parents[1]
ASSETS = ["Aura-macOS.dmg", "Aura-iOS.ipa", "SHA256SUMS", "build-manifest.json"]


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def output(args):
    return run(args, capture_output=True).stdout.strip()


def gh_json(args):
    return json.loads(output(["gh", *args]))


def digest(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def version_tuple(value):
    if not re.fullmatch(r"\d+\.\d+\.\d+", value):
        raise ValueError("A version must contain three numeric components")
    return tuple(map(int, value.split(".")))


def prepare(commit):
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("A full source commit is required")
    base = json.loads((ROOT / "apple/version.json").read_text())["version"]
    releases = gh_json(["api", f"repos/{REPOSITORY}/releases?per_page=100"])
    selected = None
    for release in releases:
        if release.get("target_commitish") == commit and re.fullmatch(r"v\d+\.\d+\.\d+", release["tag_name"]):
            selected = release["tag_name"][1:]
            break
    if selected is None:
        versions = [version_tuple(r["tag_name"][1:]) for r in releases if re.fullmatch(r"v\d+\.\d+\.\d+", r["tag_name"])]
        desired = version_tuple(base)
        if versions and max(versions) >= desired:
            major, minor, patch = max(versions)
            desired = major, minor, patch + 1
        selected = ".".join(map(str, desired))
    result = {"version": selected, "tag": "v" + selected}
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            for key, value in result.items():
                f.write(f"{key}={value}\n")
    print(json.dumps(result))


def macho_platform(binary):
    if len(binary) < 32 or binary[:4] != b"\xcf\xfa\xed\xfe":
        raise ValueError("IPA does not contain a 64-bit little-endian Mach-O executable")
    _, cpu, _, _, commands, _, _, _ = struct.unpack_from("<8I", binary)
    if cpu != 0x0100000C:
        raise ValueError("IPA executable is not arm64")
    offset = 32
    for _ in range(commands):
        command, size = struct.unpack_from("<2I", binary, offset)
        if size < 8 or offset + size > len(binary):
            raise ValueError("Invalid Mach-O load command")
        if command == 0x32:
            platform = struct.unpack_from("<I", binary, offset + 8)[0]
            if platform != 2:
                raise ValueError("IPA binary is not an iOS device build")
            return "iOS device arm64"
        offset += size
    raise ValueError("IPA executable does not declare its build platform")


def verify(directory, version, build):
    version_tuple(version)
    dmg = directory / "Aura-macOS.dmg"
    ipa = directory / "Aura-iOS.ipa"
    with zipfile.ZipFile(ipa) as package:
        if package.testzip() is not None:
            raise ValueError("IPA ZIP integrity failed")
        names = package.namelist()
        for name in names:
            path = Path(name)
            if path.is_absolute() or ".." in path.parts or not name.startswith("Payload/Aura.app/"):
                if name not in ["Payload/", "Payload/Aura.app/"]:
                    raise ValueError("Unexpected IPA member: " + name)
        info = plistlib.loads(package.read("Payload/Aura.app/Info.plist"))
        if info["CFBundleShortVersionString"] != version or info["CFBundleVersion"] != str(build):
            raise ValueError("iOS package version does not match the release")
        if info.get("CFBundleIdentifier") != "app.aura.photos" or info.get("MinimumOSVersion") != "17.0":
            raise ValueError("iOS bundle identity or minimum version mismatch")
        platform = macho_platform(package.read("Payload/Aura.app/Aura"))
        if not info.get("NSPhotoLibraryUsageDescription") or "processing" not in info.get("UIBackgroundModes", []):
            raise ValueError("iOS photo/background declarations are missing")
        if any(n.endswith("embedded.mobileprovision") for n in names):
            raise ValueError("A private provisioning profile must not enter the unsigned distribution")
        if "Payload/Aura.app/Assets.car" not in names:
            raise ValueError("iOS app icons were not compiled")
    with tempfile.TemporaryDirectory(prefix="aura-dmg-check-") as temporary:
        mount = Path(temporary) / "mount"
        run(["hdiutil", "attach", "-nobrowse", "-readonly", "-mountpoint", str(mount), str(dmg)], stdout=subprocess.DEVNULL)
        try:
            app = mount / "Aura.app"
            with (app / "Contents/Info.plist").open("rb") as f:
                info = plistlib.load(f)
            if info["CFBundleShortVersionString"] != version or info["CFBundleVersion"] != str(build):
                raise ValueError("Mac package version does not match the release")
            binary = app / "Contents/MacOS/Aura"
            architectures = set(output(["lipo", "-archs", str(binary)]).split())
            if architectures != {"arm64", "x86_64"}:
                raise ValueError("Mac package must include Apple silicon and Intel")
            run(["codesign", "--verify", "--deep", "--strict", str(app)])
            if not (mount / "Applications").is_symlink() or os.readlink(mount / "Applications") != "/Applications":
                raise ValueError("DMG installation shortcut is missing")
        finally:
            run(["hdiutil", "detach", str(mount)], stdout=subprocess.DEVNULL)
    files = {p.name: {"sha256": digest(p), "size": p.stat().st_size} for p in [dmg, ipa]}
    manifest = {"version": version, "build": str(build), "sourceCommit": output(["git", "rev-parse", "HEAD"]),
                "macOS": {"architectures": ["arm64", "x86_64"], "minimumVersion": "14.0", "signature": "ad-hoc", "notarized": False},
                "iOS": {"platform": platform, "minimumVersion": "17.0", "signature": "unsigned-for-user-sideloading"},
                "toolchain": {"xcode": output(["xcodebuild", "-version"]), "swift": output(["xcrun", "swiftc", "--version"])},
                "files": files}
    (directory / "build-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    checksums = {p.name: digest(p) for p in [dmg, ipa, directory / "build-manifest.json"]}
    (directory / "SHA256SUMS").write_text("".join(f"{hash_value}  {name}\n" for name, hash_value in checksums.items()))
    print("Verified Mac universal DMG and iOS device IPA; wrote source/version/checksum manifest")


def publish(directory, version, commit):
    tag = "v" + version
    version_tuple(version)
    manifest = json.loads((directory / "build-manifest.json").read_text())
    if manifest["sourceCommit"] != commit or manifest["version"] != version:
        raise ValueError("Refusing to publish assets from another source/version")
    for name, record in manifest["files"].items():
        if digest(directory / name) != record["sha256"]:
            raise ValueError("An installer changed after validation")
    notes = f"""Aura {version}

- **Mac：** 下载 `Aura-macOS.dmg`，打开后将 Aura 拖入 Applications。支持 Apple 芯片与 Intel，macOS 14+。
- **iPhone / iPad：** 下载 `Aura-iOS.ipa`，使用 AltStore 或 Sideloadly 导入并通过你自己的 Apple ID 签名安装。支持 iOS 17+；不能直接在 Safari 点击安装。
- 两端都在应用内输入你的服务器 HTTPS 地址，完成门户设备授权，然后允许访问照片并选择拍摄日期范围。

Mac 应用使用本地签名，未经过 Apple 公证；如系统阻止首次运行，在「系统设置 → 隐私与安全性」选择「仍要打开」。iOS 包不含开发者证书或设备描述文件，安装签名由你的侧载工具完成。免费 Apple ID 的有效期和刷新限制由 Apple 与侧载工具决定。

原件、实况视频和编辑资源均直接读取上传。iOS 后台执行时间由系统调度，首次大量导入建议保持应用打开。

源码：`{commit}`。`SHA256SUMS` 和 `build-manifest.json` 提供两端版本、构建平台和文件校验信息。
"""
    # Create a draft at the immutable source commit; publish only after remote asset verification.
    existing = subprocess.run(["gh", "release", "view", tag, "--repo", REPOSITORY, "--json", "isDraft,targetCommitish"], capture_output=True, text=True)
    if existing.returncode == 0:
        release = json.loads(existing.stdout)
        if release["targetCommitish"] != commit:
            raise ValueError("The release tag belongs to another source commit")
        if not release["isDraft"]:
            verify_remote(directory, tag, commit)
            print("Release already published and verified: " + tag)
            return
    with tempfile.TemporaryDirectory(prefix="aura-release-notes-") as temporary:
        body = Path(temporary) / "notes.md"
        body.write_text(notes)
        if existing.returncode != 0:
            run(["gh", "release", "create", tag, "--repo", REPOSITORY, "--target", commit, "--draft", "--title", "Aura " + version, "--notes-file", str(body)])
        else:
            run(["gh", "release", "edit", tag, "--repo", REPOSITORY, "--title", "Aura " + version, "--notes-file", str(body)])
        run(["gh", "release", "upload", tag, "--repo", REPOSITORY, "--clobber", *[str(directory / name) for name in ASSETS]])
        verify_remote(directory, tag, commit)
        run(["gh", "release", "edit", tag, "--repo", REPOSITORY, "--draft=false", "--latest"])
        verify_remote(directory, tag, commit)
    print("Published and verified https://github.com/" + REPOSITORY + "/releases/tag/" + tag)


def verify_remote(directory, tag, commit):
    # Draft tags do not have a REST tag endpoint until publication; inspect the release ID.
    releases = gh_json(["api", f"repos/{REPOSITORY}/releases?per_page=100"])
    match = next((r for r in releases if r["tag_name"] == tag), None)
    if match is None:
        raise ValueError("The remote release is missing: " + tag)
    release = gh_json(["api", f"repos/{REPOSITORY}/releases/{match['id']}"])
    if release["target_commitish"] != commit:
        raise ValueError("Remote release source mismatch")
    remote = {asset["name"]: asset for asset in release["assets"]}
    if set(remote) != set(ASSETS):
        raise ValueError("Remote release assets do not match the installer set")
    for name in ASSETS:
        asset = remote[name]
        local = directory / name
        if asset["state"] != "uploaded" or asset["size"] != local.stat().st_size or asset.get("digest") != "sha256:" + digest(local):
            raise ValueError("Remote installer checksum/size mismatch: " + name)
    print("Remote installer asset sizes and SHA-256 match: " + tag)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "verify", "publish", "verify-remote"])
    parser.add_argument("--directory", type=Path, default=ROOT / ".local/client-release")
    parser.add_argument("--version")
    parser.add_argument("--build", default="1")
    parser.add_argument("--commit", default=os.environ.get("GITHUB_SHA"))
    args = parser.parse_args()
    if args.action == "prepare":
        prepare(args.commit)
    elif args.action == "verify":
        verify(args.directory, args.version, args.build)
    elif args.action == "publish":
        publish(args.directory, args.version, args.commit)
    else:
        verify_remote(args.directory, "v" + args.version, args.commit)


if __name__ == "__main__":
    main()

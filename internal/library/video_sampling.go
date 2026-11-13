package library

import "context"

func (l *Library) runVideoSampleCommand(ctx context.Context, args []string, gpu, software bool) (string, error) {
	var releaseCPU, releaseGPU func()
	var err error
	if software {
		releaseCPU, err = l.acquireCPU(ctx)
		if err != nil {
			return "", err
		}
		defer releaseCPU()
	}
	if gpu {
		releaseGPU, err = l.acquireGPU(ctx)
		if err != nil {
			return "", err
		}
		defer releaseGPU()
	}
	logs := &limitedBuffer{max: 256 << 10}
	cmd := mediaCommand(ctx, "ffmpeg", args...)
	cmd.Stderr = logs
	err = cmd.Run()
	return logs.String(), err
}

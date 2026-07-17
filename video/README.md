# OpenStreamGrid Devpost Video

This directory contains the reproducible 1920×1080, 78-second Devpost video project for OpenStreamGrid.

## Dependencies

- Node.js 22 or newer
- npm
- macOS `say` and `afconvert` for the included local narration workflow
- Docker Desktop, only when recapturing the real demo

Remotion, Chromium, FFmpeg, and ffprobe are installed through the locked `video/package-lock.json` dependencies. A system FFmpeg installation is not required.

## Install

```bash
cd video
npm install
```

## Render everything

```bash
bash video/scripts/render-video.sh
```

From inside `video/`, the equivalent command is:

```bash
npm run build
```

The command generates narration and original ambient audio, renders the MP4, validates it with ffprobe, and extracts preview frames.

Final output:

```text
video/output/openstreamgrid-devpost-1080p.mp4
```

Validation report and preview frames:

```text
video/output/ffprobe.json
video/output/previews/
```

## Recapture the real Docker demo

```bash
bash video/scripts/capture-demo.sh
```

This runs the repository's isolated E2E test and stores its real output at `video/assets/demo/e2e.log`. The script cleans up its Docker project on exit. It verifies service health, HLS generation, two peer connections, P2P transfer, forced Origin fallback, the HTTP transport path, and SQLite restart persistence.

## Edit narration

1. Update `video/assets/narration.txt` for the readable master copy.
2. Apply the same wording to the caption list in `video/src/timeline.ts`.
3. Update the spoken text list in `video/scripts/generate-audio.mjs` when pronunciation spelling is needed.
4. Run `npm run audio` from `video/`.

## Edit subtitles

Update both:

- `video/assets/subtitles.srt` for the reusable subtitle file.
- `video/src/timeline.ts` for burned-in captions and narration placement.

## Change scene timing

- Composition duration and frame rate: `video/src/root.tsx`.
- Scene boundaries: `video/src/video.tsx`.
- Caption and narration cues: `video/src/timeline.ts`.

The current composition is 2,340 frames at 30 fps, or 78 seconds.

## Replace demo evidence

1. Run `bash video/scripts/capture-demo.sh`.
2. Read the final traffic summary from `video/assets/demo/e2e.log`.
3. Update `video/assets/demo/evidence.json` and the demo constants in `video/src/video.tsx`.
4. Keep the wording scoped to the captured local run.
5. Render and inspect the new preview frames.

## Manual steps

No manual editing is required for the included output. On a non-macOS machine, replace the narration generation step with WAV files using the same names under `video/public/audio/`, or render a subtitle-driven version after removing the narration `<Audio>` sequences. The ambient track generator itself is cross-platform Node.js.

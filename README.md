# ComfyUIWorkflow

A [BetterDiscord](https://betterdiscord.app) plugin that marks images, videos and audio in chat that contain an embedded [ComfyUI](https://github.com/comfyanonymous/ComfyUI) workflow or prompt.

## Features

- A **WF** badge appears on media with an embedded workflow, or **P** if only the API prompt is present.
- Click (or right-click) the badge to copy the JSON, save it as `<file name>.json` (prompts as `<file name>.prompt.json`), change the save folder, or open it.
- Supported formats: PNG, WebP, JPEG, MP4, WebM, MOV, MKV, FLAC, MP3, OGG, OPUS, M4A, WAV.

## Install

1. Copy `ComfyUIWorkflow.plugin.js` to your BetterDiscord plugins folder (`%AppData%\BetterDiscord\plugins`).
2. Enable it in Discord: Settings → Plugins.

## Settings

Plugin settings → **Choose folder...** sets where workflow JSON files are saved (default: `Documents\ComfyUI workflows`).

## Notes

- Metadata exists only in the original file. Discord may strip it from re-encoded or pasted images, so send files as attachments.
- Videos and audio are checked by reading only the first and last 4 MB.

# ComfyUIWorkflow

A [BetterDiscord](https://betterdiscord.app) plugin that marks images, videos, audio and `.json` files in chat that contain an embedded [ComfyUI](https://github.com/comfyanonymous/ComfyUI) workflow or prompt.

## Features

- A **WF** badge appears on media with an embedded workflow, or **P** if only the API prompt is present.
- Click (or right-click) the badge for:
  - **Prompts**: a window with the positive and negative prompt text (traced from the sampler), each with a Copy button
  - **Send to ComfyUI**: queues the prompt on your running ComfyUI server
  - **Models and LoRAs**: a card listing checkpoints, LoRAs, VAEs, etc. used, with a check against your server and a search link per entry (Civitai, Hugging Face, web search by file name), shown as site icons
  - **Save workflow / prompt as JSON** into a folder of your choice
- Files with several workflows (e.g. a generation graph plus post-processing) get one set of menu items per workflow.
- Supported sources: PNG, WebP, JPEG, MP4, WebM, MOV, MKV, FLAC, MP3, OGG, OPUS, M4A, WAV, `.json` attachments, and workflow JSON pasted as a code block.

## Install

1. Copy `ComfyUIWorkflow.plugin.js` to your BetterDiscord plugins folder (`%AppData%\BetterDiscord\plugins`).
2. Enable it in Discord: Settings → Plugins.

## Settings

- **Choose folder...**: where workflow JSON files are saved (default: `Documents\ComfyUI workflows`).
- **ComfyUI server URL**: default `http://127.0.0.1:8188`. Use **Test connection** to verify.

## Notes

- Metadata exists only in the original file. Discord may strip it from re-encoded or pasted images and videos, so send files as attachments.
- Videos and audio are read with HTTP Range requests (the MP4 `moov` box, or the first and last 4 MB), never downloaded in full.
- "Send to ComfyUI" needs the API-format prompt. Files that carry only the editor workflow can't be queued.

## Credits

Ideas for compressed PNG chunks, multi-workflow files, MP4 box reading, `.json` attachments, and the model/LoRA check come from [Discord-ComfyPeeper](https://github.com/ethanfel/Discord-ComfyPeeper) by ethanfel (GPL-3.0), a Vencord plugin with the same goal. No code was copied.

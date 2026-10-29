# Changelog

## 0.18.0
- Models card: "possibly related" suggestions (~) for files that share most of a name. They are never used by Queue.

## 0.17.0
- `.sft` and `.safetensors` count as the same file.

## 0.16.3
- Read workflow/prompt JSON that contains `NaN` (written by Python), which made prompts and models empty.
- Follow `BasicGuider` and `CFGGuider` to find the positive prompt.

## 0.16.2
- Restore the container styles the plugin changed when it is disabled.
- Add `@authorLink`, `@website` and `@source` to the plugin header.

## 0.16.0
- Setting: copy the saved file's path to the clipboard after saving.

## 0.15.0
- Remove "Open in ComfyUI" (it wrote into the ComfyUI workflows folder).

## 0.12.0
- "Queue in ComfyUI" adjusts model paths to what the server has, asks before using a similar quantization, and shows ComfyUI's per-node errors.

## 0.11.0
- Models card: the same file name in another folder counts as found; better quantization matching (`int8`, `convrot`, ...); opaque windows.

## 0.9.0
- Search links in the Models card are site icons.

## 0.7.0
- "Prompts" window with Copy buttons for positive and negative prompts.

## 0.6.0
- Queue the prompt in a running ComfyUI, with a Models and LoRAs card.
- Compressed PNG text chunks, MP4 box reading, `.json` attachments and pasted JSON, several workflows per file.

## 0.5.0
- Audio files (FLAC, MP3, OGG, OPUS, M4A, WAV).

## 0.4.0
- WebP, JPEG and video support; prompt-only files get a **P** badge.

## 0.3.0
- Folder picker for the save folder.

## 0.1.0
- First version: badge on PNG images with an embedded workflow.

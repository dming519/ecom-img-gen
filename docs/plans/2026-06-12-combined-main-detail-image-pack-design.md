# Combined Main And Detail Image Pack Design

## Context

The current domestic ecommerce image workflow lets the user choose one image-pack mode at a time:

- Main images: fixed 5 images, square composition.
- Detail images: fixed 8 images, vertical composition.

The user now wants main images and detail images to be selectable together and generated in one workflow.

## Decision

Change the image-pack selector from a single segmented choice to a multi-select control. Users can choose:

- Main images only: 5 prompts/images.
- Detail images only: 8 prompts/images.
- Main + detail images: 13 prompts/images in one history record.

Keep one combined history item for simultaneous generation. This keeps product context, prompt editing, generated images, and regeneration in one place.

## Data Model

Use `imageModes` as the new source state and keep `imageMode` only as a compatibility fallback for older drafts and histories.

Each prompt item will store its own `imageMode`, so the app can derive the correct generation settings per image:

- Main prompt item: `1:1`, square image size.
- Detail prompt item: `3:4`, vertical image size.

The product snapshot stores the selected `imageModes` and derived total count.

## Prompt Generation

The browser sends `imageModes` to `/api/prompt`. The server normalizes the selection and derives the expected total:

- `["main"]` -> 5.
- `["detail"]` -> 8.
- `["main", "detail"]` -> 13.

The LLM output must include `imageMode` on each prompt item. Worker validation checks both total count and per-mode counts before marking the prompt task successful.

## UI And Flow

The product form shows two toggleable options: `主图 5 张` and `详情图 8 张`. At least one option must stay selected.

The prompt list and preview show the current item group (`主图` or `详情图`). Batch image generation continues to run sequentially, but each image uses its own prompt item's aspect ratio and size.

## Compatibility

Existing records with only `imageMode` are read as a one-item `imageModes` array. Records with no mode fall back to detail mode.

## Verification

Run `npm run check`. Verify that:

- Main only creates 5 prompt items.
- Detail only creates 8 prompt items.
- Main + detail creates 13 prompt items in one history item.
- Batch generation uses `1:1` for main items and `3:4` for detail items.

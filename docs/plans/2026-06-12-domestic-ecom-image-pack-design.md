# Domestic Ecom Image Pack Design

## Context

The current image workflow asks users to choose an arbitrary image count and sends a broad prompt template to the LLM. The target audience is domestic ecommerce, so the workflow should optimize for Taobao/Tmall, JD, Douyin, Xiaohongshu, and similar Chinese commerce contexts.

## Decision

Replace free image-count selection with a fixed image-pack mode:

- Main images: 5 images, default square composition.
- Detail images: 8 images, default vertical detail-page composition.

The browser sends `imageMode` instead of trusting a user-provided count. The server derives the count from the mode and sends the mode into the prompt task. This keeps frontend state, stored history, and backend generation aligned.

## Prompt Strategy

The prompt template will become a domestic ecommerce planner:

- Diagnose category, target buyer, purchase scene, and conversion driver.
- Build a buyer reason card before writing image prompts.
- Define a campaign style lock and reuse it in every image prompt.
- Use an image-copy gate for each frame: objective, headline, labels, proof or offer line, and layout.
- Produce different required sequences for main images and detail images.
- Keep Chinese copy short and readable; avoid asking the image model to render dense paragraphs.

## UI Changes

The product form keeps the existing three-column workbench. The count selector is replaced with a segmented image-pack selector:

- Main image: 5 images.
- Detail image: 8 images.

Add compact domestic ecommerce context fields:

- Target platform.
- Target audience / purchase scene.
- Price band.
- Proof / review / qualification materials.
- Offer / service promise.

These fields enrich the prompt without forcing a multi-step wizard.

## Data Flow

`ProductInput`, prompt generation options, history, and draft state store `imageMode` and the domestic context fields. Existing histories without the new fields fall back to detail mode and five-image legacy count where needed, but new prompt generation always uses fixed mode counts.

Prompt text remains stored in the backend, but the status endpoint returns prompt text so users can inspect and edit it. Detail image generation can accept the edited prompt text. The server still validates ownership through `promptId` when present.

## Verification

Run `npm run check` after implementation. Existing generated histories should still load, while new generation should create exactly 5 main-image prompts or 8 detail-image prompts.

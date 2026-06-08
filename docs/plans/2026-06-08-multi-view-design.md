# Multi-View Product Image Design

## Goal

Enable the existing "多视角" entry as a dedicated workspace for generating multiple pure white-background product images from uploaded product references.

The output must be product-only: no marketing copy, no angle labels, no decorative props, no scene background, and no detail-page layout.

## User Flow

1. User opens the existing "多视角" entry and lands on `/multi-view/`.
2. User uploads 1-8 product reference images.
3. User selects the number of views to generate, from 1-8.
4. User optionally selects aspect ratio and quality. The default should be `1:1` and `1K`.
5. User starts generation.
6. The system automatically assigns standard product angles based on the requested count.
7. Results appear as a grid with per-image status, preview, zoom, and download actions.

## Angle Allocation

The user chooses only the output count. The system assigns angles automatically:

- 1 image: front view.
- 2 images: front view, back view.
- 3 images: front view, left 45-degree view, back view.
- 4 images: front view, left side, right side, back view.
- 5 images: front view, left side, right side, back view, top view.
- 6 images: front view, left side, right side, back view, top view, bottom view.
- 7 images: front view, left side, right side, back view, top view, bottom view, product detail view.
- 8 images: front view, left side, right side, back view, top view, bottom view, product detail view, packaging side or structure view.

The prompt should let the model adapt impractical angles by product shape. For example, a soft bag may use seam/detail views instead of a meaningful bottom view.

## Output Rules

Every generated image must follow these constraints:

- Pure white background.
- Product body only.
- No Chinese or English marketing text.
- No angle label.
- No icons, badges, borders, cards, shadows as design elements, or scene props.
- No human model, hand, table, shelf, packaging mockup, or lifestyle background unless it is part of the product itself.
- Product color, material, structure, visible logo, label layout, and proportions must stay consistent with uploaded references.
- If the requested view is not directly visible in references, the model may infer the missing side from visible structure, but must not redesign the product.

## Architecture

Use a separate multi-view workspace rather than mixing this flow into detail images or cutout.

Recommended route and components:

- Add `/multi-view/` page.
- Reuse the existing top-level `ImageGenerator` shell only if it stays simple; otherwise create a focused `MultiViewStudio.vue`.
- Wire the existing homepage and header "多视角" entry to `/multi-view/`.
- Reuse existing upload compression patterns from detail image generation.
- Reuse existing image task creation and polling APIs for each generated view.
- Add multi-view-specific prompt construction in the frontend or shared lib. This flow does not need editable prompt text.

## Data Model

Add dedicated multi-view state and history instead of storing it as detail history:

- Product reference images and image IDs.
- Requested view count.
- Assigned angle list.
- Aspect ratio and quality.
- Per-view status: draft, queued, running, succeeded, failed.
- Per-view output image ID or base64.
- Created and updated timestamps.

History can follow the same D1/R2 storage pattern already used by detail and cutout records.

## Error Handling

- If no image is uploaded, block generation and ask for at least one product reference image.
- If an image is too large or invalid, reject it with the same behavior as the detail image upload flow.
- If generation fails for one view, keep successful views and allow regenerating the failed item.
- If the user cancels, reset queued/running views to draft or canceled without deleting completed outputs.
- If references are insufficient for back, bottom, or side views, still generate but keep the prompt constrained to reasonable structural inference.

## Acceptance Criteria

- Existing "多视角" navigation opens a working `/multi-view/` route.
- User can upload multiple product images and choose 1-8 outputs.
- The system automatically creates angle tasks without exposing prompt editing.
- Generated prompts enforce pure white background and product-only output.
- Results show per-angle progress and final images.
- User can zoom and download generated images.
- The feature does not alter detail image or cutout workflows.
- Type checks pass.

## Open Implementation Notes

- Start with existing image generation endpoints to reduce backend risk.
- Add dedicated history after the first generation loop is stable if needed for scope control.
- Keep UI dense and operational, matching the current workbench style rather than making a marketing page.

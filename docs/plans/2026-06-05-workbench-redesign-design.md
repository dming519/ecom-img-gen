# EcomImgGen Workbench Redesign

## Goal

Rebuild the first screen as a professional creative production workbench for ecommerce detail-image generation. The UI should feel like a serious tool: dense, scannable, and image-first, with prompt editing and generation state visible without scrolling through unrelated cards.

## Layout

- Desktop uses a three-pane studio layout:
  - Left rail: product input, reference images, output settings, primary actions.
  - Center canvas: large generated-image preview, generation strip, active image actions.
  - Right rail: prompt queue with title, status, and editable prompt text.
- History becomes a compact dock below the studio grid.
- Top bar replaces the centered hero header and fixed floating buttons.
- Mobile collapses to a single-column workflow in this order: access, inputs, canvas, prompt queue, history.

## Visual System

- Palette: neutral graphite/white surfaces with a restrained cyan-blue accent. Avoid warm orange gradients and decorative background blobs.
- Typography: system sans with tighter hierarchy; compact labels and clear section titles.
- Corners: 8-12px for functional panels and controls, not oversized cards.
- Elevation: subtle borders and one low shadow level; no hover-card theatrics.
- Controls: large primary action for prompt generation, secondary action for image generation, compact chips for settings and statuses.

## Interaction

- Logged-out state is a slim access banner plus disabled workspace, not a centered marketing card.
- Active prompt and active preview remain visually linked through index and status.
- Upload area presents image thumbnails as production references, with add/clear controls kept compact.
- Empty states stay understated and should not dominate the screen.

## Acceptance Criteria

- The first viewport clearly reads as a tool, not a landing page.
- Desktop view shows input, canvas, and prompt queue at once.
- Mobile view has no overlapping text or horizontally overflowing controls.
- Existing generation, polling, history, login, and lightbox behavior remain intact.
- `npm run build` passes.

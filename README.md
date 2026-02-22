# personas

<img width="300" height="165" alt="Screenshot 2026-02-22 at 2 59 24 PM" src="https://github.com/user-attachments/assets/08c7b7a2-2d26-4612-9529-c5814079d0b8" />


A small, public collection of persona assets used across the `tjamescouch/*` agent ecosystem.

Today this repo primarily contains **Ellie** (a character/persona + associated assets).

## Repo layout

- `ellie/`
  - `ellie_animation.glb` — 3D asset (Git LFS)

## Usage

This repository is intended to be consumed by other projects via a git submodule, a direct clone, or by downloading specific assets.

Example (clone):

```bash
git clone https://github.com/tjamescouch/personas
```

## Adding a new persona

1. Create a top-level folder named after the persona (e.g. `alex/`).
2. Put assets inside that folder.
3. Add/extend this README with:
   - what the persona is
   - what assets are included
   - licensing + required attribution

If you add large binary assets (e.g. `.glb`), use Git LFS.

## Licensing & attribution

### Ellie (CC BY 4.0)

Ellie assets in `ellie/` are provided under **Creative Commons Attribution 4.0 International (CC BY 4.0)**.

Attribution requirement:
- **Author/Attribution name:** Ellie
- **License:** CC BY 4.0
- **License link:** https://creativecommons.org/licenses/by/4.0/

If you redistribute or use Ellie assets publicly, you must provide attribution consistent with CC BY 4.0.

## Notes

- If you add third-party assets, include their license and attribution requirements in this README.

# Font credits

Where every typeface the app bundles comes from, and under what licence. All four are shipped
inside the app, so nothing is fetched from a font service, and all four are released under the
[SIL Open Font License 1.1](https://openfontlicense.org), which allows them to be bundled and
redistributed with the app as long as their copyright notice and licence travel with them.

The first three arrive as npm packages from [Fontsource](https://fontsource.org), which carry each
family's own `LICENSE` file. Roboto is vendored under `src/renderer/src/assets/fonts/roboto/`, with
its `LICENSE` beside it.

| Typeface      | Where the app uses it                         | Copyright                                                                                                                  | Package                              |
| ------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **Tiny5**     | Labels, and the default interface face        | Copyright 2022-2024 The Tiny5 Project Authors ([Gissio/font_tiny5](https://github.com/Gissio/font_tiny5))                  | `@fontsource/tiny5`                  |
| Jacquard 12   | Titles                                        | Copyright 2023 The Soft Type Project Authors ([scfried/soft-type-jacquard](https://github.com/scfried/soft-type-jacquard)) | `@fontsource/jacquard-12`            |
| Pixelify Sans | Messages and small text                       | Copyright 2021 The Pixelify Sans Project Authors ([eifetx/Pixelify-Sans](https://github.com/eifetx/Pixelify-Sans))         | `@fontsource-variable/pixelify-sans` |
| Roboto        | An interface and messaging choice in Settings | Copyright 2011 The Roboto Project Authors ([googlefonts/roboto-classic](https://github.com/googlefonts/roboto-classic))    | vendored                             |

Tiny5 is the pixel face the panel was designed around. Its author featured DwarfAI-Miners on the
[Tiny5 page](https://gissio.itch.io/tiny5) (#651). Thank you.

## Adding a typeface

1. Only a font under the SIL Open Font License (or a licence at least as permissive) ships.
2. Prefer its Fontsource package, so its `LICENSE` comes with it; a vendored copy keeps its
   `LICENSE` in the same folder.
3. Add its row here, with the copyright line exactly as its `LICENSE` states it.

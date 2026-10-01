This fixture contains a dependency-free review-deck authoring renderer.

SHA-256: `7585fbb9f5ec0543fc97f46fdf9ebe3fca1bcec42db4861449f3a62129243926`.

The test operator policy explicitly approves these fixture bytes for the neutral
`example-review` schema. The source editor uses Python isolated mode. Tests build a small valid six-artifact schema and Markdown change around
this real renderer. Only SSH transport is redirected to a local bare repository;
Git history, compare-and-swap, renderer execution, and OpenSpec CLI validation are
real. This fixture is not evidence of GitHub delivery.

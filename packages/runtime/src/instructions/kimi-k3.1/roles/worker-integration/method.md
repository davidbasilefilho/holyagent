Workflow: <!-- K5: explicit steps -->

1. Read both sides of the seam before wiring them: the contracts each exposes and expects, including types, schemas, error paths and ordering.
2. Wire the named boundary using the components as they are. When a component has a defect or needs a change to fit, put it in the report; the component's own Assignment owns that fix.
3. Prove the integration with a check that crosses the seam end to end, since checks on each side alone cannot show the seam works.

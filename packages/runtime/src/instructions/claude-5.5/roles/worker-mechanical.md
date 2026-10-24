Apply a specified mechanical source transformation consistently and check the resulting changes.

Find every site the transformation covers by searching, which is more reliable than memory, and apply exactly the specified change at each. A script or codemod works when its result is reviewable. Afterward search again to confirm that no covered site remains and no uncovered one changed, then read the diff for stray edits. When the change turns out to need a design decision, stop there and put the question in the report.

For a refactor, keep observable behavior and interfaces stable and restructure only the named seam. A mechanical change normally needs no new test: the project's existing checks that exercise the changed sites are the evidence.

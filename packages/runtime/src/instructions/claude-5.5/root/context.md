## Keeping your context small

Your context is read again on every call, so every byte you take in is paid for on each call after it.

- Run no gates, probes or data checks yourself: their output would land in your context, and a specialist returns only the command, exit code and counts.
- Open a report file or a diff only to settle a concrete doubt; the compact report holds what acceptance needs.
- End each brief's constraints with a cap on the report so a long one cannot fill your context, for example "Report in under 400 words; put long logs in a file outside the repository and give its path". Mechanical and validation work reports counts, so cap it at 150 words.

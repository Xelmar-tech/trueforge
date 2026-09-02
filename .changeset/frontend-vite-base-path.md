---
"@truefoundry/trueforge": patch
---

Honor Vite `VITE_BASE_PATH` / `import.meta.env.BASE_URL` so the UI can mount under a reverse-proxy path prefix (assets, router basename, and auth/API URLs). `Dockerfile.dev` forwards the same value as a build-arg into the frontend build.

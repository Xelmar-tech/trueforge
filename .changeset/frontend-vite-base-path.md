---
"@truefoundry/trueforge": patch
---

Honor build-time `ROOT_PATH` (Vite `base` → `import.meta.env.BASE_URL`) for reverse-proxy mounts, and load Swagger UI's OpenAPI URL as a relative `openapi.json` so docs work behind a strip-prefix path.

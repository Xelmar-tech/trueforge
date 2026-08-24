---
"@truefoundry/trueforge": patch
"@truefoundry/trueforge-sdk": patch
"@truefoundry/trueforge-ui": patch
---

Fix custom model provider delete and update when legacy manifests omit `manifest.name`, which broke SDK parsing and dropped `base_url` from the UI. Hydrate custom provider names on list responses, add DELETE `/settings/model-providers/{name}`, and wire the settings Remove action.

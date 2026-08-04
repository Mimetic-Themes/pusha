# Dawn port — worker output manifest

Theme audited: Dawn (upstream `main`)
Run mode: hand-written reference port (validates the skill's contract before automating)

## Transformations

### `sections/main-addresses.liquid` — bucket E (procedural inline script)

**Patch**: `sections-main-addresses.patch`

**Original** (lines 20, 385):
```liquid
<div class="customer addresses section-{{ section.id }}-padding" data-customer-addresses>
...
<script>
  window.addEventListener('load', () => {
    typeof CustomerAddresses !== 'undefined' && new CustomerAddresses();
  });
</script>
```

**Transformed**:
```liquid
<div class="customer addresses section-{{ section.id }}-padding" data-section-type="main-addresses" data-section-id="{{ section.id }}" data-customer-addresses>
...
{% javascript %}
  window.theme = window.theme || {};
  window.theme.sectionInits = window.theme.sectionInits || {};
  window.theme.sectionInits['main-addresses'] = function(root) {
    if (root.dataset.initialized === 'true') return;
    if (typeof CustomerAddresses === 'undefined') return;
    root.dataset.initialized = 'true';
    new CustomerAddresses();
  };
{% endjavascript %}
```

**Rules applied** (from `PATTERNS.md` bucket E):
1. ✅ Added `data-section-type="main-addresses"` + `data-section-id="{{ section.id }}"` to section root
2. ✅ Moved inline `<script>` body to `window.theme.sectionInits['main-addresses']`
3. ✅ Switched from inline `<script>` to `{% javascript %}` so the assignment lives in the deferred bundle and is available before `initPage()` runs after PJAX swap
4. ✅ Added `data-initialized` idempotency guard on `root.dataset` (handles theme editor `section:load` re-firing)
5. ✅ Preserved the original `typeof CustomerAddresses !== 'undefined'` guard — the external class may not have finished loading on first PJAX nav
6. ⏩ N/A — no `document.querySelector` calls inside the script body (the original constructor was called without args)

**Behavioral verification**:
- Initial load: section's `data-section-type` is detected by `initPage()`, the handler instantiates `CustomerAddresses` once.
- PJAX nav away and back: new container has a fresh root with no `dataset.initialized`, handler re-instantiates `CustomerAddresses` on the new DOM.
- Same-page re-init (theme editor `section:load`): guard returns early because `dataset.initialized === 'true'` on the unchanged root.

## Deferred concerns (worker flagged, did not edit)

### `assets/customer.js` — external class definition not audited

The transformed section instantiates `CustomerAddresses`, but that class is defined in `assets/customer.js` (loaded via `<script src="{{ 'customer.js' | asset_url }}" defer>` at line 3 of `main-addresses.liquid`, outside this patch's scope).

**Open question** the worker cannot answer without reading `assets/customer.js`:
- Does `CustomerAddresses` constructor accept a root element, or does it `document.querySelector` internally?
- Does it attach listeners to `window` or `document` that need cleanup on the section being removed?
- Does it hold module-level state?

**Recommendation**: a follow-up audit pass on `assets/customer.js` should classify it (likely bucket D — extends-HTMLElement-without-cleanup, or a plain class needing a `destroy()` method). The current patch makes the *call site* PJAX-safe, but residual issues from the class itself are out of scope for a single-file E transformation.

This is the **cross-file rule** from `SKILL.md`: workers return SKIP rather than touching files they weren't assigned. Surfacing the concern in the manifest is the correct handoff.

## Lessons for the skill's contract

The worked transformation surfaced two things worth pinning down in `PATTERNS.md` before automating:

1. **External class references inside wrapped scripts** are a common case (any `new SomeClass()` or `SomeClass.init()` where `SomeClass` is defined elsewhere). The worker should flag these in the manifest with a "verify class lifecycle" note. PATTERNS.md bucket E doesn't currently mention this; should add a "Cross-file dependencies" subsection.

2. **`{% javascript %}` vs `<script>` choice for the wrapped block** — using `{% javascript %}` is correct here because the assignment to `sectionInits` must persist into the deferred bundle, but PATTERNS.md doesn't explicitly say *why* the example uses `{% javascript %}`. Worth a one-sentence rationale.

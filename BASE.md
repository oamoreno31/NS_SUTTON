# Preebook Reports — Carpeta Base

Documentación de los scripts en `Desarrollo/Base/`: el motor genérico (shell + librería común) que sirve todos los reportes del Preebook (R1, R2, R3, ...), más un Suitelet legacy independiente.

## Arquitectura general

Los reportes nuevos (R1 Hardgoods, R2 Greens, R3 Hardgoods Raw Materials, ...) NO son Suitelets propios en NetSuite. Son **librerías** (módulos AMD sin `@NScriptType`) que un único Suitelet — el shell — carga dinámicamente según un registro. Cada librería solo implementa un contrato fijo (metadata, filtros, generación); todo lo demás (formulario, validación de campos obligatorios, preview embebido, entrega del archivo) lo resuelve el shell una sola vez para todos los reportes.

```
customrecord_sgp_rpt_registry (registro NetSuite)
        │  una fila por reporte activo: code, name, libpath, order, description
        ▼
prbk_sl_reports_shell.js  (Suitelet único, deployado 1 vez)
        │  require([libpath]) según el reporte elegido
        ▼
prbk_lib_r1_*.js / prbk_lib_r2_*.js / prbk_lib_r3_*.js  (una librería por reporte)
        │  usa helpers compartidos
        ▼
prbk_lib_reports_common.js  (BOM, inventario, PO, UOM, render PDF)
```

`prbk_cs_reports_shell.js` es el único Client Script, compartido también por todos los reportes (auto-submit al cambiar el dropdown de reporte). `prbk_lib_template.js` es el punto de partida para crear una librería nueva. `sl_prebook_report_csv.js` es un Suitelet aparte, anterior a esta arquitectura (ver sección final).

## Registro de reportes: `customrecord_sgp_rpt_registry`

| Campo | Uso |
|---|---|
| `name` | Nombre visible en el dropdown "Report" |
| `custrecord_sgp_rpt_code` | Código interno único, se usa en la URL (`custpage_report`) |
| `custrecord_sgp_rpt_libpath` | Ruta al módulo de la librería en el File Cabinet (sin `.js`) |
| `custrecord_sgp_rpt_active` | Filtra qué reportes aparecen (el shell solo trae `isinactive = F`) |
| `custrecord_sgp_rpt_order` | Orden de aparición en el dropdown |
| `custrecord_sgp_rpt_description` | Texto de ayuda mostrado sobre los filtros |

Para publicar un reporte nuevo: subir la librería al File Cabinet y crear una fila en este registro apuntando a su `libpath`. No hace falta tocar el shell.

## Contrato de una librería de reporte

Toda librería (`prbk_lib_r*.js`) exporta un objeto AMD con estas funciones:

```js
define(['./prbk_lib_reports_common', ...], (common, ...) => {
    const getMetadata = () => ({ id, name, description, formats: ['EXCEL','PDF'] });
    const getFilterDefinitions = () => ([ /* array de defs de filtro */ ]);
    const validateFilters = (values) => ({ valid: true|false, message });   // opcional
    const getPreviewData = (filterValues) => ({ /* ver abajo */ });          // opcional
    const generate = (filterValues) => ({ fileObj, filename, contentType } | { html });
    return { getMetadata, getFilterDefinitions, validateFilters, getPreviewData, generate };
});
```

- **`getMetadata()`** — describe el reporte. `formats` (array de strings, ej. `['EXCEL','PDF']`) se usa para filtrar qué botones de descarga se muestran en el preview.
- **`getFilterDefinitions()`** — array de definiciones de filtro (ver tabla de tipos abajo). El shell las convierte en campos del formulario NetSuite y valida `mandatory` antes de llamar `generate`.
- **`validateFilters(values)`** *(opcional)* — validación cruzada entre filtros (ej. fecha_desde < fecha_hasta). Si devuelve `{valid:false}`, el shell corta con un error y no llama `generate`.
- **`generate(filterValues)`** — produce la salida real. Devuelve `{ fileObj, filename, contentType }` (el shell hace `ctx.response.writeFile`, `isInline` = true para PDF/HTML) o `{ html }` (el shell escribe el HTML directo, sin archivo).
- **`getPreviewData(filterValues)`** *(opcional, recomendado)* — misma data que `generate()` pero en JSON plano, sin generar archivo, para el preview embebido (ver sección Preview). Si una librería no la implementa, el shell no ofrece preview y el botón pasa a ser "Generate Report" directo.

### Tipos de filtro soportados (`getFilterDefinitions`)

`text`, `longtext`, `textarea`, `integer`, `float`, `currency`, `percent`, `date`, `datetime`, `checkbox`, `select`, `multiselect`. Propiedades comunes de cada def: `id`, `label`, `type`, `mandatory`, `helpText`, `defaultValue`, `source` (para `select`/`multiselect` ligados a un record type), `options` (array `{value,text}` para select manual), `readonly`, `placeholder`.

`previewChoice: true` marca un filtro como parte del control de preview en vez de un filtro real: no se muestra como campo normal, se maneja client-side. Dos usos:
- Filtro de formato de salida (ej. `output_format`) — se vuelve campo oculto, los botones "Download Excel/PDF" del preview lo setean antes de re-enviar el form.
- Checkbox de vista (ej. "Show recipe audit", "Show audit") — con `hideColumns: ['COL A','COL B']` oculta/muestra columnas por CSS sin recargar la página; sin `hideColumns`, reenvía el formulario completo (server-side refresh, para checkboxes que cambian el cálculo, no solo la vista).

## `prbk_lib_reports_common.js` — helpers compartidos

Usados por R1/R2/R3 para no repetir lógica de NetSuite:

- **`loadAssemblyBoms(assemblyItemIds)`** — componentes del BOM default (revisión más reciente) de una lista de assemblies.
- **`getOnHandAllLocations(itemIds)`** — on-hand sumado entre todas las locations, por item.
- **`getPoQty(rawItemIds, prebookId, mode)`** — cantidad de PO recibida (`mode:'received'`) o en tránsito, filtrado por `custbody_sgp_report_id` = prebook.
- **`getUomConversions(rawItemIds)`** — heurística Stem/Bunch/Case: detecta `stemsPerBunch` y `bunchesPerCase` por item leyendo su `unitstype`, con fallback a `custitem_sgp_packing`.
- **`renderPdf(opts)`** — wrapper de `N/render` para Advanced PDF Templates: carga el record del Prebook, agrega el datasource JSON, devuelve el PDF. Nota: `renderer.addRecord` requiere el objeto `{templateName, record}` (no argumentos posicionales) — bug ya corregido aquí.
- **`escapeXml(s)`** / **`ceilSafe(n)`** — utilidades varias (escape para SpreadsheetML, redondeo hacia arriba seguro).

## `prbk_lib_template.js` — plantilla para reportes nuevos

Esqueleto mínimo que implementa el contrato completo. Pasos para crear un reporte nuevo:

1. Copiar `prbk_lib_template.js` con un nombre nuevo (`prbk_lib_rN_<nombre>.js`).
2. Completar `getMetadata()` (id, name, description, formats soportados).
3. Definir los filtros en `getFilterDefinitions()`. Si el reporte tiene preview con descarga en varios formatos, agregar el filtro `output_format` con `previewChoice: true` (ejemplo comentado en el archivo).
4. Implementar `generate()` con la lógica real (usar `prbk_lib_reports_common` para BOM/inventario/PO/UOM/PDF).
5. (Recomendado) Implementar `getPreviewData()` devolviendo la misma data en JSON — habilita el preview embebido antes de descargar.
6. Subir el archivo al File Cabinet y crear la fila correspondiente en `customrecord_sgp_rpt_registry`.

### Forma de `getPreviewData()`

```js
{
    title: 'Nombre del reporte',
    prebookName: '...',
    metaLines: ['línea de contexto 1', 'línea de contexto 2'],
    headers: ['Col A', 'Col B'],
    rows: [ ['v1','v2'], ... ],   // plano
    rowCount: N
}
```

Para reportes con sub-filas (ej. recetas en R1), cada fila de `rows` puede ser un objeto jerárquico en vez de un array plano:

```js
{ cells: ['v1','v2'], subRows: [...], visibleSubRows: [...], recipeCount: N }
```

El shell normaliza ambos formatos (`normalizePreviewRow`). `visibleSubRows` se pintan siempre; `subRows` quedan colapsadas detrás de un toggle "View N more..." cuando `recipeCount > 5`.

Para reportes con varias vistas descargables por separado (ej. R3: Main/Category/Vendor), en vez de `headers`/`rows` se devuelve `views: [{ id, label, headers, rows }, ...]` — el shell detecta `Array.isArray(previewData.views)` y usa `buildTabbedPreviewFragment` (pestañas) en vez de `buildPreviewFragment`.

## `prbk_sl_reports_shell.js` — el Suitelet

Único punto de entrada NetSuite para todos los reportes nuevos. Responsabilidades:

- **Registro y selección**: `loadReportRegistry()` trae las filas activas; `onRequest` resuelve qué librería cargar según `custpage_report` y hace `require([entry.libpath], ...)`.
- **`renderForm`**: arma el formulario NetSuite — dropdown de reporte, campos de filtro dinámicos (`addDynamicField`, uno por cada def de `getFilterDefinitions`), botón (Preview/Generate según si la librería implementa `getPreviewData`), y el fragmento de preview embebido si corresponde (campo `INLINEHTML`).
- **`handleGenerate`**: valida filtros obligatorios, llama `validateFilters` si existe, llama `generate()` y entrega el resultado (`ctx.response.writeFile` o `ctx.response.write(html)`).
- **`handlePreview`**: llama `getPreviewData()` y arma el HTML del preview (`buildPreviewFragment` o `buildTabbedPreviewFragment` si hay `views`).
- **Preview embebido**: vive DENTRO del mismo `<form name="main_form">` de NetSuite (no navega a otra página). Incluye buscador (compara solo contra la 2da columna de las filas padre), paginación client-side (10 filas padre por página, las sub-filas viajan con su padre), collapse de sub-filas cuando hay más de 5, y botones de descarga que setean campos ocultos (`custpage_action=generate`, el filtro de formato) y reenvían el mismo form.
- **Toggles previewChoice**: los que traen `hideColumns` ocultan/muestran columnas por CSS sin recargar (`pbToggleColumns`); los que no, reenvían el formulario completo para recalcular server-side (`pbSetHiddenAndRefresh`).
- **Vista con pestañas** (`buildTabbedPreviewFragment`): usada por reportes con varias vistas descargables (ej. R3). Soporta secciones colapsables dentro de cada pestaña vía marcadores especiales en la primera celda (`§SECTION§label§N§count`).

## `prbk_cs_reports_shell.js` — Client Script

Único Client Script, compartido por el shell. `fieldChanged` en el dropdown de reporte reenvía el formulario (`custpage_action=load_filters`) para que el shell rearme los filtros del reporte recién seleccionado.

## `sl_prebook_report_csv.js` — Suitelet legacy (independiente)

Suitelet propio (`@NScriptType Suitelet`), NO pasa por el shell ni implementa el contrato de librería — es anterior a esta arquitectura. Genera el reporte histórico del Preebook (ventas/customer/product) a partir de `customrecord_sgp_prebook_projection_rp` y transacciones de venta, con exportación a CSV/PDF y comparativos "this year" (TY) por item/customer usando fechas del Prebook (`custrecord_sgp_pb_current_start_date`/`end_date`). Sigue activo y deployado aparte; no requiere fila en `customrecord_sgp_rpt_registry`. No se tocó su lógica en la limpieza de comentarios — solo se validó que no tuviera bloques de comentario largos que simplificar.

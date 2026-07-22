/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 *
 * Helpers compartidos para los reportes nuevos del Preebook (R1-R4).
 * Esta librería NO se invoca como Script; se requiere desde otras librerías de reporte y
 * desde el Suitelet shell. Mantener acá toda lógica reusable: lookups de inventario, POs,
 * BOM, conversiones UOM y wrapper de render PDF.
 */
define([
    'N/search',
    'N/record',
    'N/render',
    'N/log',
    'N/format'
], (search, record, render, log, format) => {

    // ----------------------------------------------------------------------
    // BOM — Assemblies (item.bom default revision)
    // ----------------------------------------------------------------------

    /**
     * Devuelve, por cada assembly item, su lista de componentes del BOM marcado como default.
     *
     * Estrategia (NetSuite nativo):
     *   - Buscar tipo `bomrevision` joineado con `billofmaterials` (assembly + isdefault)
     *     y con `component` para obtener cada raw material y su qty.
     *   - Si un assembly tiene varias revisions del BOM default, conservamos la más reciente
     *     por effective date.
     *
     * @param {Array<string|number>} assemblyItemIds
     * @returns {Object} map { assemblyItemId: [{ rawId, qty, unitsType }, ...] }
     */
    const loadAssemblyBoms = (assemblyItemIds) => {
        const ids = Array.from(new Set((assemblyItemIds || []).filter(Boolean).map(String)));
        if (!ids.length) return {};

        const assemblyCol = search.createColumn({ name: 'assembly', join: 'billofmaterials', label: 'ASSEMBLY' });
        const rawCol = search.createColumn({ name: 'item', join: 'component', label: 'RAW_ITEM' });
        const qtyCol = search.createColumn({ name: 'bomquantity', join: 'component', label: 'QTY' });
        const uomCol = search.createColumn({ name: 'units', join: 'component', label: 'UOM' });
        const effCol = search.createColumn({ name: 'effectivestartdate', sort: search.Sort.DESC, label: 'EFF' });

        const compSearch = search.create({
            type: 'bomrevision',
            filters: [
                ['billofmaterials.assembly', 'anyof', ids], 'AND',
                ['billofmaterials.isdefault', 'is', 'T'], 'AND',
                ['isinactive', 'is', 'F']
            ],
            columns: [assemblyCol, rawCol, qtyCol, uomCol, effCol]
        });

        // Como ordenamos por effectivestartdate DESC, la primera ocurrencia de
        // (assembly, raw) corresponde a la revisión más reciente — la conservamos
        // y descartamos duplicados de revisiones anteriores.
        const result = {};
        const seen = {};   // `${assemblyId}|${rawId}` -> true
        const paged = compSearch.runPaged({ pageSize: 1000 });
        paged.pageRanges.forEach((pr) => {
            paged.fetch({ index: pr.index }).data.forEach((r) => {
                const assemblyId = r.getValue(assemblyCol);
                const rawId = r.getValue(rawCol);
                const qty = Number(r.getValue(qtyCol)) || 0;
                const uom = r.getValue(uomCol);

                if (!assemblyId || !rawId || !qty) return;
                const k = `${assemblyId}|${rawId}`;
                if (seen[k]) return;
                seen[k] = true;

                if (!result[assemblyId]) result[assemblyId] = [];
                result[assemblyId].push({ rawId: String(rawId), qty: qty, unitsType: uom });
            });
        });

        return result;
    };

    // ----------------------------------------------------------------------
    // Inventory On Hand (suma todas las locations)
    // ----------------------------------------------------------------------

    /**
     * @param {Array<string|number>} itemIds
     * @returns {Object} { itemId: totalOnHand }
     */
    const getOnHandAllLocations = (itemIds) => {
        const ids = Array.from(new Set((itemIds || []).filter(Boolean).map(String)));
        if (!ids.length) return {};

        const s = search.create({
            type: search.Type.ITEM,
            filters: [['internalid', 'anyof', ids]],
            columns: [
                search.createColumn({
                    name: 'internalid',
                    summary: search.Summary.GROUP
                }),
                search.createColumn({
                    name: 'locationquantityonhand',
                    summary: search.Summary.SUM,
                    label: 'OH_ALL_LOC'
                })
            ]
        });

        const map = {};
        const paged = s.runPaged({ pageSize: 1000 });
        paged.pageRanges.forEach((pr) => {
            paged.fetch({ index: pr.index }).data.forEach((r) => {
                const id = r.getValue({ name: 'internalid', summary: search.Summary.GROUP });
                const oh = Number(r.getValue({ name: 'locationquantityonhand', summary: search.Summary.SUM })) || 0;
                if (id) map[id] = oh;
            });
        });
        return map;
    };

    // ----------------------------------------------------------------------
    // Purchase Orders — RECVD / INBOUND filtrados por custbody_sgp_report_id
    // ----------------------------------------------------------------------

    /**
     * Suma cantidades de PO líneas filtradas por:
     *   - type = PurchOrd
     *   - mainline = F
     *   - custbody_sgp_report_id = prebookId
     *   - item anyof rawItemIds
     *
     * Modes:
     *   'received' -> SUM(quantityreceived)
     *   'inbound'  -> SUM(quantity - NVL(quantityreceived,0))
     *
     * @returns {Object} { rawItemId: qty }
     */
    const getPoQty = (rawItemIds, prebookId, mode) => {
        const ids = Array.from(new Set((rawItemIds || []).filter(Boolean).map(String)));
        if (!ids.length || !prebookId) return {};

        const isReceived = (mode === 'received');

        const itemCol = search.createColumn({
            name: 'item',
            summary: search.Summary.GROUP,
            label: 'ITEM'
        });

        const qtyCol = isReceived
            ? search.createColumn({
                name: 'quantityreceived',
                summary: search.Summary.SUM,
                label: 'QTY'
            })
            : search.createColumn({
                name: 'formulanumeric',
                formula: 'NVL({quantity},0) - NVL({quantityreceived},0)',
                summary: search.Summary.SUM,
                label: 'QTY'
            });

        const s = search.create({
            type: search.Type.TRANSACTION,
            filters: [
                ['type', 'anyof', 'PurchOrd'], 'AND',
                ['mainline', 'is', 'F'], 'AND',
                ['custbody_sgp_report_id', 'anyof', String(prebookId)], 'AND',
                ['item', 'anyof', ids]
            ],
            columns: [itemCol, qtyCol]
        });

        const map = {};
        const paged = s.runPaged({ pageSize: 1000 });
        paged.pageRanges.forEach((pr) => {
            paged.fetch({ index: pr.index }).data.forEach((r) => {
                const id = r.getValue(itemCol);
                const q = Number(r.getValue(qtyCol)) || 0;
                if (id) map[id] = (map[id] || 0) + q;
            });
        });
        return map;
    };

    // ----------------------------------------------------------------------
    // UOM conversions — heurística Stem / Bunch / Case
    // ----------------------------------------------------------------------

    /**
     * Para una lista de items raw, determina:
     *   - stemsPerBunch: stems por unidad "bunch" (regex/heurística sobre uomname)
     *   - bunchesPerCase: bunches por unidad "case"
     *
     * Estrategia: para cada item leemos sus units (`unitsofmeasure` sublist del unitstype).
     * Cada renglón tiene { unitname, conversionrate } donde conversionrate está respecto a la baseunit.
     *
     * Buscamos por patrón (case-insensitive) en `unitname`:
     *   - "stem" o "stm"     -> unidad stem
     *   - "bunch" o "bch" o "bnch" -> unidad bunch
     *   - "case" o "cs" o "ctn" o "carton" o "box" -> unidad case
     *
     * @param {Array<string|number>} rawItemIds
     * @returns {Object} { itemId: { stemsPerBunch, bunchesPerCase, base, bunchPack } }
     */
    const getUomConversions = (rawItemIds) => {
        const ids = Array.from(new Set((rawItemIds || []).filter(Boolean).map(String)));
        if (!ids.length) return {};

        // 1. Para cada item, obtener su unitstype e info adicional
        const itemUomSearch = search.create({
            type: search.Type.ITEM,
            filters: [['internalid', 'anyof', ids]],
            columns: [
                search.createColumn({ name: 'internalid', label: 'ITEM' }),
                search.createColumn({ name: 'unitstype', label: 'UOM_TYPE' }),
                search.createColumn({ name: 'baseunit', label: 'BASE_UNIT' }),
                search.createColumn({ name: 'custitem_sgp_packing', label: 'PACK' })
            ]
        });

        const itemMeta = {};   // itemId -> { uomTypeId, baseUnitId, packing }
        const uomTypeIds = new Set();

        itemUomSearch.run().each((r) => {
            const itemId = r.getValue({ name: 'internalid' });
            const uomTypeId = r.getValue({ name: 'unitstype' });
            const baseUnitId = r.getValue({ name: 'baseunit' });
            const packing = r.getValue({ name: 'custitem_sgp_packing' });
            itemMeta[itemId] = { uomTypeId, baseUnitId, packing };
            if (uomTypeId) uomTypeIds.add(uomTypeId);
            return true;
        });

        // 2. Cargar todos los unitstype involucrados con sus uom rows
        // El record 'unitstype' tiene la sublist 'uom' con campos: pluralname/unitname/conversionrate/baseunit/internalid
        const uomTypeMap = {};   // uomTypeId -> { rows: [{unitId, name, conversionrate, isBase}] }
        Array.from(uomTypeIds).forEach((utid) => {
            try {
                const rec = record.load({ type: 'unitstype', id: utid });
                const lineCount = rec.getLineCount({ sublistId: 'uom' });
                const rows = [];
                for (let i = 0; i < lineCount; i++) {
                    rows.push({
                        unitId: rec.getSublistValue({ sublistId: 'uom', fieldId: 'internalid', line: i }),
                        name: String(rec.getSublistValue({ sublistId: 'uom', fieldId: 'unitname', line: i }) || '').trim(),
                        plural: String(rec.getSublistValue({ sublistId: 'uom', fieldId: 'pluralname', line: i }) || '').trim(),
                        abbr: String(rec.getSublistValue({ sublistId: 'uom', fieldId: 'abbreviation', line: i }) || '').trim(),
                        conversionrate: Number(rec.getSublistValue({ sublistId: 'uom', fieldId: 'conversionrate', line: i })) || 0,
                        isBase: !!rec.getSublistValue({ sublistId: 'uom', fieldId: 'baseunit', line: i })
                    });
                }
                uomTypeMap[utid] = { rows };
            } catch (e) {
                log.error('getUomConversions.loadUomType', `Falló load unitstype ${utid}: ${e.message}`);
            }
        });

        // 3. Heurística para identificar stem / bunch / case por nombre
        const matchUnit = (rows, patterns) => {
            const lowerPats = patterns.map((p) => p.toLowerCase());
            return rows.find((row) => {
                const blob = `${row.name} ${row.plural} ${row.abbr}`.toLowerCase();
                return lowerPats.some((p) => blob.includes(p));
            });
        };

        const STEM_PATTERNS = ['stem', 'stm'];
        const BUNCH_PATTERNS = ['bunch', 'bnch', 'bch'];
        const CASE_PATTERNS = ['case', 'carton', 'ctn', 'box', 'pack'];

        // 4. Por cada item resolver stemsPerBunch y bunchesPerCase
        const out = {};
        Object.keys(itemMeta).forEach((itemId) => {
            const meta = itemMeta[itemId];
            const uomEntry = uomTypeMap[meta.uomTypeId];
            const result = {
                stemsPerBunch: 1,
                bunchesPerCase: Number(meta.packing) || 1,
                source: 'fallback'
            };

            if (uomEntry && uomEntry.rows.length) {
                const stem = matchUnit(uomEntry.rows, STEM_PATTERNS);
                const bunch = matchUnit(uomEntry.rows, BUNCH_PATTERNS);
                const cs = matchUnit(uomEntry.rows, CASE_PATTERNS);

                // conversionrate = unidades base por 1 unidad de este renglón
                // Si base es Stem: bunch.conversionrate = stems por bunch
                // Si base es Bunch: stem.conversionrate = bunches por stem (= 1/stemsPerBunch)
                // Para robustez, calculamos relativo:
                //   stemsPerBunch = bunch.cr / stem.cr  (si ambos existen)
                //   bunchesPerCase = case.cr / bunch.cr (si ambos existen)
                if (stem && bunch && stem.conversionrate > 0) {
                    result.stemsPerBunch = bunch.conversionrate / stem.conversionrate;
                }
                if (bunch && cs && bunch.conversionrate > 0) {
                    result.bunchesPerCase = cs.conversionrate / bunch.conversionrate;
                }
                result.source = 'uomTable';
                result.detected = {
                    stem: stem ? stem.name : null,
                    bunch: bunch ? bunch.name : null,
                    case: cs ? cs.name : null
                };
            }

            // Saneo: nunca dividir por 0
            if (!result.stemsPerBunch || result.stemsPerBunch <= 0) result.stemsPerBunch = 1;
            if (!result.bunchesPerCase || result.bunchesPerCase <= 0) result.bunchesPerCase = Number(meta.packing) || 1;

            out[itemId] = result;
        });

        return out;
    };

    // ----------------------------------------------------------------------
    // Render PDF (wrapper consistente con el patrón del Suitelet 3856)
    // ----------------------------------------------------------------------

    /**
     * @param {Object} opts
     * @param {number|string} opts.templateId - ID del Advanced PDF Template
     * @param {string|number} opts.prebookId  - ID del Preebook (se carga el record para el header)
     * @param {Object} opts.data              - { report: [...rows], action: 'R1', ... }
     * @param {string} opts.filename
     * @returns {File}
     */
    const renderPdf = (opts) => {
        const renderer = render.create();
        renderer.setTemplateById(opts.templateId);

        const preBookObj = record.load({
            type: 'customrecord_sgp_prebook',
            id: opts.prebookId
        });
        renderer.addRecord('record', preBookObj);

        renderer.addCustomDataSource({
            format: render.DataSource.JSON,
            alias: 'data',
            data: JSON.stringify(opts.data)
        });

        const pdfFile = renderer.renderAsPdf();
        if (opts.filename) pdfFile.name = opts.filename;
        return pdfFile;
    };

    // ----------------------------------------------------------------------
    // Helpers misc
    // ----------------------------------------------------------------------

    const escapeXml = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    const ceilSafe = (n) => {
        const v = Number(n);
        if (!isFinite(v) || v <= 0) return 0;
        return Math.ceil(v);
    };

    return {
        loadAssemblyBoms,
        getOnHandAllLocations,
        getPoQty,
        getUomConversions,
        renderPdf,
        escapeXml,
        ceilSafe
    };
});

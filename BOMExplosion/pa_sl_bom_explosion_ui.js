/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
define([
    'N/ui/serverWidget',
    'N/query',
    'N/url',
    'N/format',
    'N/runtime',
    './pa_ser_response_lib_util'
], (serverWidget, query, url, format, runtime, responseLib) => {

    const DEFAULT_PAGE_SIZE = 500; 

    function onRequest(context) {
        if (context.request.method === 'GET') {
            renderUI(context);
        } else if (context.request.method === 'POST') {
            handleApiRequest(context);
        }
    }

    // ==========================================
    // 1. FRONTEND: Interfaz PWA con Infinite Scrolling, SheetJS y UX Feedback
    // ==========================================
    function renderUI(context) {
        const form = serverWidget.createForm({ title: 'BOM Explosion (BOM & Revisions)' });
        
        const htmlField = form.addField({
            id: 'custpage_html_container',
            type: serverWidget.FieldType.INLINEHTML,
            label: 'Container'
        });

        const currentScript = runtime.getCurrentScript();
        const suiteletUrl = url.resolveScript({
            scriptId: currentScript.id,
            deploymentId: currentScript.deploymentId
        });

        htmlField.defaultValue = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <script src="https://cdn.jsdelivr.net/npm/ag-grid-community@31.3.2/dist/ag-grid-community.min.noStyle.js"></script>
                <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/ag-grid-community@31.3.2/styles/ag-grid.css">
                <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/ag-grid-community@31.3.2/styles/ag-theme-alpine.css">
                
                <script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
                
                <style>
                    .pwa-container { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 15px; }
                    .filter-bar { display: flex; gap: 15px; margin-bottom: 20px; flex-wrap: wrap; background: #f3f4f6; padding: 15px; border-radius: 8px; align-items: flex-end; }
                    .filter-group { display: flex; flex-direction: column; }
                    .filter-group label { font-weight: 600; font-size: 12px; margin-bottom: 4px; color: #374151; }
                    .filter-group input { padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 14px; }
                    .btn-action { padding: 8px 16px; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; transition: background-color 0.2s; display: flex; align-items: center; justify-content: center; }
                    .btn-action:disabled { opacity: 0.7; cursor: not-allowed; }
                    .btn-search { background-color: #2563eb; }
                    .btn-search:hover:not(:disabled) { background-color: #1d4ed8; }
                    .btn-export { background-color: #10b981; }
                    .btn-export:hover:not(:disabled) { background-color: #059669; }
                    #myGrid { height: 600px; width: 100%; border: 1px solid #d1d5db; border-radius: 4px; }
                    
                    /* Spinner CSS */
                    .spinner { animation: rotate 2s linear infinite; width: 18px; height: 18px; margin-right: 8px; }
                    .spinner .path { stroke: #ffffff; stroke-linecap: round; animation: dash 1.5s ease-in-out infinite; }
                    @keyframes rotate { 100% { transform: rotate(360deg); } }
                    @keyframes dash {
                        0% { stroke-dasharray: 1, 150; stroke-dashoffset: 0; }
                        50% { stroke-dasharray: 90, 150; stroke-dashoffset: -35; }
                        100% { stroke-dasharray: 90, 150; stroke-dashoffset: -124; }
                    }
                </style>
            </head>
            <body>
                <div class="pwa-container">
                    <div class="filter-bar">
                        <div class="filter-group" style="display: none;">
                            <label>Ship Date (End)</label>
                            <input type="date" id="shipDate" title="Optional. Will search 2 weeks back from this date">
                        </div>
                        <div class="filter-group">
                            <label>Sales Order (ID or TranId)</label>
                            <input type="text" id="soSearch" placeholder="Ex. 12345 or SO-001">
                        </div>
                        <div class="filter-group">
                            <label>Customer (Entity ID)</label>
                            <input type="text" id="customerSearch" placeholder="Ex. CUST-123">
                        </div>
                        <div class="filter-group">
                            <label>Item (ID or Name)</label>
                            <input type="text" id="itemSearch" placeholder="Ex. 678 or ITEM-A">
                        </div>
                        <div class="filter-group">
                            <label>BOM Effective Date</label>
                            <input type="date" id="bomDate" title="Search valid Revisions on this date">
                        </div>
                        <button type="button" id="btnSearch" class="btn-action btn-search" onclick="applyFilters()">Run BOM Explosion</button>
                        <button type="button" id="btnExport" class="btn-action btn-export" onclick="exportToExcel()">Export to Excel (.xlsx)</button>
                    </div>
                    <div id="myGrid" class="ag-theme-alpine"></div>
                </div>

                <script>
                    let currentFilters = {};
                    let gridApi; 

                    const gridOptions = {
                        columnDefs: [
                            { field: "assembly_name", headerName: "Assembly (Item)", minWidth: 180 },
                            { field: "bom_name", headerName: "BOM Name", minWidth: 150 },
                            { field: "customer_entityid", headerName: "Customer (BOM)", minWidth: 140 },
                            { field: "bom_createddate", headerName: "BOM Created Date", minWidth: 160 },
                            { field: "nombrerevision", headerName: "Styles", minWidth: 150 },
                            { field: "effectivestartdate", headerName: "Effective Start Date", minWidth: 160 },
                            { field: "effectiveenddate", headerName: "Effective End Date", minWidth: 160 },
                            { field: "comp_item", headerName: "Component Styles", minWidth: 180 },
                            { field: "comp_quantity", headerName: "Style Qty", minWidth: 110 },
                            { field: "comp_units", headerName: "Units", minWidth: 100 },
                            { field: "comp_itemsource", headerName: "Source", minWidth: 120 },
                            { field: "subcomp_item", headerName: "Subcomponent (WO/Phantom)", minWidth: 200 },
                            { field: "subcomp_quantity", headerName: "Subcomponent Qty", minWidth: 150 },
                            { field: "total_componente", headerName: "Total Component", minWidth: 150 }
                        ],
                        defaultColDef: { flex: 1, resizable: true },
                        rowModelType: 'infinite',
                        cacheBlockSize: ${DEFAULT_PAGE_SIZE},
                        pagination: true,
                        paginationPageSize: ${DEFAULT_PAGE_SIZE},
                        maxBlocksInCache: 10 
                    };

                    document.addEventListener('DOMContentLoaded', () => {
                        const gridDiv = document.querySelector('#myGrid');
                        gridApi = agGrid.createGrid(gridDiv, gridOptions);
                    });

                    function applyFilters() {
                        const btn = document.getElementById('btnSearch');
                        const originalText = 'Run BOM Explosion';
                        
                        btn.disabled = true;
                        btn.innerHTML = '<svg class="spinner" viewBox="0 0 50 50"><circle class="path" cx="25" cy="25" r="20" fill="none" stroke-width="5"></circle></svg> Processing...';

                        currentFilters = {
                            soSearch: document.getElementById('soSearch').value,
                            customerSearch: document.getElementById('customerSearch').value,
                            itemSearch: document.getElementById('itemSearch').value,
                            bomDate: document.getElementById('bomDate').value
                        };

                        const dataSource = {
                            getRows: async (params) => {
                                const pageIndex = Math.floor(params.startRow / ${DEFAULT_PAGE_SIZE});
                                
                                const payload = {
                                    filters: currentFilters,
                                    pageIndex: pageIndex,
                                    pageSize: ${DEFAULT_PAGE_SIZE}
                                };

                                try {
                                    const response = await fetch('${suiteletUrl}', {
                                        method: 'POST',
                                        headers: { 
                                            'Content-Type': 'application/json',
                                            'Accept': 'application/json'
                                        },
                                        body: JSON.stringify(payload)
                                    });
                                    
                                    const json = await response.json();
                                    
                                    if (json.success) {
                                        const records = json.data.records;
                                        const totalRecords = json.data.pagination.totalRecords;
                                        params.successCallback(records, totalRecords);
                                    } else {
                                        params.failCallback();
                                        alert('Error fetching data: ' + json.error.message);
                                    }
                                } catch (err) {
                                    console.error(err);
                                    params.failCallback();
                                    alert('Connection error parsing response.');
                                } finally {
                                    if (btn.disabled) {
                                        btn.disabled = false;
                                        btn.innerHTML = originalText;
                                    }
                                }
                            }
                        };

                        gridApi.setGridOption('datasource', dataSource);
                    }

                    // ==========================================
                    // SOLUCIÓN EXCEL: Chunking Frontend para Dataset Ilimitado
                    // ==========================================
                    async function exportToExcel() {
                        const btn = document.getElementById('btnExport');
                        const originalText = 'Export to Excel (.xlsx)';
                        
                        btn.disabled = true;
                        
                        try {
                            let allRecords = [];
                            let pageIndex = 0;
                            let hasMore = true;
                            let totalExpected = 0;

                            // Bucle de recolección hasta agotar la base de datos de NetSuite
                            while (hasMore) {
                                btn.innerHTML = '<svg class="spinner" viewBox="0 0 50 50"><circle class="path" cx="25" cy="25" r="20" fill="none" stroke-width="5"></circle></svg> Fetching ' + allRecords.length + '...';

                                const payload = {
                                    filters: currentFilters,
                                    pageIndex: pageIndex,
                                    pageSize: 1000 // Tamaño máximo nativo de página en NetSuite
                                };

                                const response = await fetch('${suiteletUrl}', {
                                    method: 'POST',
                                    headers: { 
                                        'Content-Type': 'application/json',
                                        'Accept': 'application/json'
                                    },
                                    body: JSON.stringify(payload)
                                });
                                
                                const json = await response.json();
                                
                                if (json.success && json.data.records) {
                                    allRecords = allRecords.concat(json.data.records);
                                    hasMore = json.data.pagination.hasMore;
                                    totalExpected = json.data.pagination.totalRecords;
                                    pageIndex++;
                                    
                                    // Feedback en tiempo real para el usuario
                                    btn.innerHTML = '<svg class="spinner" viewBox="0 0 50 50"><circle class="path" cx="25" cy="25" r="20" fill="none" stroke-width="5"></circle></svg> Fetching ' + allRecords.length + ' / ' + totalExpected;
                                } else {
                                    alert('Error fetching data to export.');
                                    hasMore = false;
                                    break;
                                }
                            }

                            if (allRecords.length > 0) {
                                btn.innerHTML = '<svg class="spinner" viewBox="0 0 50 50"><circle class="path" cx="25" cy="25" r="20" fill="none" stroke-width="5"></circle></svg> Generating Excel...';
                                generateTrueExcel(allRecords);
                            } else {
                                alert('No data found to export.');
                            }

                        } catch (err) {
                            console.error(err);
                            alert('Connection error during export.');
                        } finally {
                            btn.innerHTML = originalText;
                            btn.disabled = false;
                        }
                    }

                    function generateTrueExcel(data) {
                        if (!data || data.length === 0) {
                            alert('No data to export.');
                            return;
                        }

                        const excelData = data.map(row => ({
                            "Assembly (Item)": row.assembly_name || "",
                            "BOM Name": row.bom_name || "",
                            "Customer (BOM)": row.customer_entityid || "",
                            "BOM Created Date": row.bom_createddate || "",
                            "Styles": row.nombrerevision || "",
                            "Effective Start Date": row.effectivestartdate || "",
                            "Effective End Date": row.effectiveenddate || "",
                            "Component Styles": row.comp_item || "",
                            "Style Qty": row.comp_quantity || "",
                            "Units": row.comp_units || "",
                            "Source": row.comp_itemsource || "",
                            "Subcomponent (WO/Phantom)": row.subcomp_item || "",
                            "Subcomponent Qty": row.subcomp_quantity || "",
                            "Total Component": row.total_componente || 0
                        }));

                        const worksheet = XLSX.utils.json_to_sheet(excelData);
                        const workbook = XLSX.utils.book_new();
                        
                        XLSX.utils.book_append_sheet(workbook, worksheet, "BOM Explosion");
                        XLSX.writeFile(workbook, 'BOM_Explosion_Report.xlsx');
                    }
                </script>
            </body>
            </html>
        `;
        context.response.writePage(form);
    }

    // ==========================================
    // 2. BACKEND: Lógica de Explosión con SuiteQL (BOM Nativo)
    // ==========================================
    function handleApiRequest(context) {
        try {
            let body = {};
            let rawBody = context.request.body;
            
            if (rawBody && typeof rawBody === 'string') {
                const start = rawBody.indexOf('{');
                const end = rawBody.lastIndexOf('}');
                
                if (start > -1 && end > -1 && end >= start) {
                    const cleanJsonString = rawBody.substring(start, end + 1);
                    body = JSON.parse(cleanJsonString);
                } else {
                    log.debug('Payload sin formato JSON ignorado', rawBody);
                }
            }

            const filters = body.filters || {};
            const pageIndex = Math.max(Number(body.pageIndex) || 0, 0);
            
            // LÍMITE DE SEGURIDAD NETSUITE: Permite hasta 1000 registros por query paged para no colapsar en la exportación
            const pageSize = Math.min(Math.max(Number(body.pageSize) || DEFAULT_PAGE_SIZE, 1), 1000);

            const data = getExplosionData(filters, { pageIndex, pageSize });
            responseLib.writeJson(context.response, responseLib.success(data));
        } catch (e) {
            log.error('API Error', e);
            responseLib.writeJson(context.response, responseLib.error('EXPLOSION_ERROR', e.message, e.stack));
        }
    }

    function getExplosionData(filters, paging) {
        let params = [];
        
        let sql = `
            SELECT DISTINCT
                BUILTIN.DF(iaib.assembly) AS assembly_name,
                bom.name AS bom_name,
                c.entityid AS customer_entityid,
                bom.createddate AS bom_createddate,
                bomRev.name AS nombrerevision,
                bomRev.effectivestartdate AS effectivestartdate,
                bomRev.effectiveenddate AS effectiveenddate,
                BUILTIN.DF(comp.item) AS comp_item,
                comp.bomquantity AS comp_quantity,
                BUILTIN.DF(comp.units) AS comp_units,
                comp.itemsource AS comp_itemsource,
                BUILTIN.DF(subcomp.item) AS subcomp_item,
                subcomp.bomquantity AS subcomp_quantity,
                -- Cálculo Total Componente (Math)
                (NVL(comp.bomquantity, 0) * NVL(subcomp.bomquantity, 1)) AS total_componente
            FROM 
                bom
            INNER JOIN itemAssemblyItemBom iaib ON iaib.billofmaterials = bom.id
            LEFT JOIN customer c ON bom.custrecord_sgp_bom_customer = c.id
            INNER JOIN bomRevisionBomMap map ON map.billofmaterials = bom.id
            INNER JOIN bomRevision bomRev ON bomRev.id = map.bomrevision AND NVL(bomRev.isinactive, 'F') = 'F'
            INNER JOIN bomRevisionComponentMember comp ON comp.bomrevision = bomRev.id
            
            -- EXPLOSIÓN DE SUBCOMPONENTES (Condicionada a itemsource = 'Work Order' o 'Phantom')
            LEFT JOIN itemAssemblyItemBom sub_iaib 
                ON sub_iaib.assembly = comp.item 
                AND UPPER(comp.itemsource) IN ('WORK_ORDER', 'PHANTOM')
            LEFT JOIN bom sub_bom ON sub_bom.id = sub_iaib.billofmaterials
            LEFT JOIN bomRevisionBomMap sub_map ON sub_map.billofmaterials = sub_bom.id
            LEFT JOIN bomRevision sub_bomRev ON sub_bomRev.id = sub_map.bomrevision AND NVL(sub_bomRev.isinactive, 'F') = 'F'
            LEFT JOIN bomRevisionComponentMember subcomp ON subcomp.bomrevision = sub_bomRev.id
            
            WHERE NVL(bom.isinactive, 'F') = 'F'
            
            -- REGLA DE NEGOCIO ESTRICTA (PHANTOM & WORK ORDER):
            -- La primera explosión de un Work Order o Phantom NO se muestra como material final.
            -- SOLO se muestran las líneas relacionadas a la segunda explosión (subcomponentes).
            -- Para las líneas que NO son WO o Phantom, SÍ se muestra la primera explosión.
            AND (
                (UPPER(comp.itemsource) IN ('WORK_ORDER', 'PHANTOM') AND subcomp.item IS NOT NULL)
                OR 
                (UPPER(comp.itemsource) NOT IN ('WORK_ORDER', 'PHANTOM'))
            )
        `;

        // ==========================================
        // Filtro de Fechas exacto evadiendo el Timezone Shift
        // ==========================================
        if (filters.bomDate) {
            const [year, month, day] = filters.bomDate.split('-');
            const correctLocalDate = new Date(year, month - 1, day);
            
            const formattedBomDate = format.format({ value: correctLocalDate, type: format.Type.DATE });
            
            sql += ` AND bomRev.effectivestartdate <= ? AND (bomRev.effectiveenddate IS NULL OR bomRev.effectiveenddate >= ?) `;
            params.push(formattedBomDate, formattedBomDate);
        }
        
        if (filters.customerSearch) {
            const customerValue = String(filters.customerSearch).trim();
            sql += ` AND UPPER(c.entityid) LIKE UPPER(?) `;
            params.push(`%${customerValue}%`);
        }

        if (filters.soSearch) {
            const soValue = String(filters.soSearch).trim();
            if (!isNaN(soValue)) {
                sql += ` AND iaib.assembly IN (SELECT tl.item FROM transaction t INNER JOIN transactionLine tl ON t.id = tl.transaction WHERE t.type = 'SalesOrd' AND (t.id = ? OR UPPER(t.tranid) LIKE UPPER(?))) `;
                params.push(parseInt(soValue, 10), `%${soValue}%`);
            } else {
                sql += ` AND iaib.assembly IN (SELECT tl.item FROM transaction t INNER JOIN transactionLine tl ON t.id = tl.transaction WHERE t.type = 'SalesOrd' AND UPPER(t.tranid) LIKE UPPER(?)) `;
                params.push(`%${soValue}%`);
            }
        }

        if (filters.itemSearch) {
            const itemValue = String(filters.itemSearch).trim();
            if (!isNaN(itemValue)) {
                sql += ` AND (iaib.assembly = ? OR UPPER(BUILTIN.DF(iaib.assembly)) LIKE UPPER(?)) `;
                params.push(parseInt(itemValue, 10), `%${itemValue}%`);
            } else {
                sql += ` AND UPPER(BUILTIN.DF(iaib.assembly)) LIKE UPPER(?) `;
                params.push(`%${itemValue}%`);
            }
        }

        sql += ` ORDER BY BUILTIN.DF(iaib.assembly), bom.name, bomRev.effectivestartdate DESC, BUILTIN.DF(comp.item) `;

        return runPagedSuiteQL(sql, params, paging);
    }

    // ==========================================
    // 3. Sistema de Paginación para SuiteQL
    // ==========================================
    function runPagedSuiteQL(sql, params, paging) {
        const pagedData = query.runSuiteQLPaged({
            query: sql,
            params: params,
            pageSize: paging.pageSize,
        });
        
        const totalPages = pagedData.pageRanges.length;

        if (totalPages === 0 || paging.pageIndex >= totalPages) {
            return {
                records: [],
                pagination: { pageIndex: paging.pageIndex, pageSize: paging.pageSize, totalRecords: pagedData.count, totalPages, hasMore: false },
            };
        }

        const page = pagedData.fetch({ index: paging.pageIndex });
        
        // ==========================================
        // Recorte del sufijo del año (_YYYY)
        // ==========================================
        const mappedRecords = page.data.asMappedResults().map(row => {
            if (row.nombrerevision && typeof row.nombrerevision === 'string') {
                row.nombrerevision = row.nombrerevision.replace(/_\d{4}$/, '');
            }
            return row;
        });

        return {
            records: mappedRecords,
            pagination: {
                pageIndex: paging.pageIndex,
                pageSize: paging.pageSize,
                totalRecords: pagedData.count,
                totalPages,
                hasMore: paging.pageIndex + 1 < totalPages,
            },
        };
    }

    return {
        onRequest: onRequest
    };
});
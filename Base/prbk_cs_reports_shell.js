/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope Public
 *
 * Client Script asociado a `prbk_sl_reports_shell.js`.
 *
 * Única responsabilidad:
 *   Cuando el usuario cambia el dropdown "Report", marcar la acción como
 *   `load_filters` y disparar un submit del form para que el server
 *   re-renderice los filtros del nuevo reporte.
 *
 * Toda la lógica del reporte sigue siendo server-side. Este script no toca
 * datos ni hace lookups — solo dispara el refresh.
 */
define([], () => {

    // -----------------------------------------------------------------------
    // Constantes — deben coincidir con las del Suitelet shell
    // -----------------------------------------------------------------------
    const FLD_REPORT = 'custpage_report';
    const FLD_ACTION = 'custpage_action';
    const ACTION_LOAD_FILTERS = 'load_filters';

    // -----------------------------------------------------------------------
    // pageInit — se mantiene aunque no se use, NetSuite a veces lo requiere
    // -----------------------------------------------------------------------
    const pageInit = (/* context */) => { /* no-op */ };

    // -----------------------------------------------------------------------
    // fieldChanged — el único evento real que nos interesa
    // -----------------------------------------------------------------------
    const fieldChanged = (context) => {
        if (context.fieldId !== FLD_REPORT) return;

        const rec = context.currentRecord;
        const reportVal = rec.getValue({ fieldId: FLD_REPORT });

        // Si el usuario "selecciona la opción vacía" no hacemos nada — el form
        // se quedará tal cual hasta que elija un reporte real.
        if (!reportVal) return;

        // Marcar acción = load_filters para que el server entienda que es
        // un refresh y no un generate.
        try {
            rec.setValue({ fieldId: FLD_ACTION, value: ACTION_LOAD_FILTERS });
        } catch (e) {
            // Fallback al DOM si setValue falla (campo en HIDDEN puede no estar
            // expuesto vía currentRecord en algunas versiones de NetSuite).
            const actionEl = document.getElementById(FLD_ACTION);
            if (actionEl) actionEl.value = ACTION_LOAD_FILTERS;
        }

        // Disparar submit nativo del form. Usamos document.forms['main_form'].submit()
        // en lugar de NLDoMainFormButtonAction porque .submit() nativo BYPASSEA
        // la validación client-side de NetSuite (los filtros mandatory aún no
        // están llenos en este punto — eso es esperado, los validamos en el
        // server después).
        try {
            const f = (typeof document !== 'undefined') && document.forms
                ? document.forms['main_form']
                : null;
            if (f && typeof f.submit === 'function') {
                f.submit();
            }
        } catch (e) {
            if (typeof console !== 'undefined' && console.error) {
                console.error('prbk_cs_reports_shell.submit', e);
            }
        }
    };

    return {
        pageInit,
        fieldChanged
    };
});

/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope Public
 */
define([], () => {

    const FLD_REPORT = 'custpage_report';
    const FLD_ACTION = 'custpage_action';
    const ACTION_LOAD_FILTERS = 'load_filters';

    const pageInit = () => {};

    const fieldChanged = (context) => {
        if (context.fieldId !== FLD_REPORT) return;

        const rec = context.currentRecord;
        const reportVal = rec.getValue({ fieldId: FLD_REPORT });

        if (!reportVal) return;

        try {
            rec.setValue({ fieldId: FLD_ACTION, value: ACTION_LOAD_FILTERS });
        } catch (e) {
            const actionEl = document.getElementById(FLD_ACTION);
            if (actionEl) actionEl.value = ACTION_LOAD_FILTERS;
        }

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

/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
const TY_SO_STATUSES = ['SalesOrd:B', 'SalesOrd:D', 'SalesOrd:E', 'SalesOrd:F'];

define(['N/record', 'N/runtime', 'N/search', 'N/ui/serverWidget', 'N/redirect', 'N/url', 'N/file', 'N/render', 'N/log'],
  (record, runtime, search, serverWidget, redirect, url, file, render, log) => {

    const onRequest = (scriptContext) => {
      try {
        const functionName = 'onRequest';
        try {
          handleGetOperation(scriptContext);
        } catch (ex) {
          const errorStr = (ex && ex.name) ? `${ex.name}</br>${ex.message}</br>${ex.stack}</br>` : String(ex);
          log.error('Error', `A problem occured whilst : <br>${errorStr}<br>functionName>>>>${functionName}`);
        }
      } catch (_ignore) { }
    };

    const handleGetOperation = (scriptContext) => {
      const objRequest = scriptContext.request;
      const params = objRequest.parameters || {};
      const pageId = params.pageId;
      const action = params.csvFileData || ''; // 'product' | 'customer' | 'sales' | pdf actions
      let prebookname = '';

      log.debug('CSV Entry', {
        action: action,
        prebook: params.prebook || '',
        year: params.year || '',
        accountmanager: params.accountmanager || '',
        salessupport: params.salessupport || '',
        productcode: params.productcode || '',
        catid: params.catid || '',
        childcustomer: params.childcustomer || '',
        parentcustomer: params.parentcustomer || ''
      });


      const rpSearchObj = getprebook(params);
      const retrieveSearchcount = rpSearchObj.count;
      log.debug('retrieveSearchcount', retrieveSearchcount);

      const rows = getAllResults(rpSearchObj);

      const custIds = [], itemIds = [];
      rows.forEach(r => {
        custIds.push(r.getValue({ name: 'custrecord_sgp_cust_code' }));
        let parent = r.getValue({ name: 'custentity_bc_parent_company', join: 'CUSTRECORD_SGP_CUST_CODE' })
        if (parent) {
          custIds.push(parent);
        }
        itemIds.push(r.getValue({ name: 'internalid', join: 'CUSTRECORD_SGP_PRODUCT_CODE' }));
      });

      let tyMap = {}, shipMap = {}, defaults = {};
      try {
        if (params.prebook) {
          const pb = search.lookupFields({
            type: 'customrecord_sgp_prebook',
            id: params.prebook,
            columns: [
              'custrecord_sgp_pb_historical_start_date',
              'custrecord_sgp_pb_historical_end_date',
              'custrecord_sgp_pb_current_start_date',
              'name',
              'custrecord_sgp_pb_currency_end_date'
            ]
          });
          defaults.currentStartDate = pb.custrecord_sgp_pb_current_start_date || '';
          defaults.currentEndDate = pb.custrecord_sgp_pb_currency_end_date || '';
          prebookname = pb.name;
        }
        if (defaults.currentStartDate && defaults.currentEndDate) {
          tyMap = buildTyMapForPage({ start: defaults.currentStartDate, end: defaults.currentEndDate, itemIds, customerIds: custIds });
          shipMap = getShipDate({ start: defaults.currentStartDate, end: defaults.currentEndDate, itemIds, customerIds: custIds });
        }
      } catch (e) { log.error('TY/Ship map build error', e); }

      const ccppMap = getCustomerItemNumber(custIds, itemIds);
      let subcategory = getsubcategory();

      const finalData = [];
      rows.forEach(r => {
        let Product = r.getValue({ name: 'mpn', join: 'CUSTRECORD_SGP_PRODUCT_CODE' });
        let Desc = r.getValue({ name: 'displayname', join: 'CUSTRECORD_SGP_PRODUCT_CODE' });



        let ItemSub2 = r.getText({ name: 'custitem_sgp_subcategory', join: 'CUSTRECORD_SGP_PRODUCT_CODE' }) || '';
        let ItemSub = r.getValue({ name: 'custitem_sgp_subcategory', join: 'CUSTRECORD_SGP_PRODUCT_CODE' }) || '';
        let sgp_code = subcategory[ItemSub] || 'None';
        let DisplayCat = sgp_code + '-' + ItemSub2 || 'None';
        let CatTxt = DisplayCat;
        let Season = r.getText({ name: 'custitem_cseg_sgp_prodseason', join: 'CUSTRECORD_SGP_PRODUCT_CODE' });
        let Pack = r.getValue({ name: 'custitem_sgp_packing', join: 'CUSTRECORD_SGP_PRODUCT_CODE' }) || '';
        let prebook_cases_txt = r.getValue({ name: 'custrecord_sgp_prebook_cases_txt' });
        let AM = r.getText({ name: 'salesrep', join: 'CUSTRECORD_SGP_CUST_CODE' }) || '';
        let LY = r.getValue({ name: 'custrecord_sgp_ly_cases' }) || 0;
        let PBcases = r.getValue({ name: 'custrecord_sgp_prebook_cases' }) || 0;
        let LYUnits = Number(LY) * Number(PBcases);
        let PBUnits = r.getValue({ name: 'custrecord_sgp_prebook_qty' }) || 0;
        let Status = r.getValue({ name: 'custrecord_sgp_excess_lyqty' });
        let PBStatus = r.getText({ name: 'custrecord_sgp_approval_status' }) || '';
        let custId = r.getValue({ name: 'custrecord_sgp_cust_code' });
        let parentId = r.getValue({ name: 'custentity_bc_parent_company', join: 'CUSTRECORD_SGP_CUST_CODE' }) || custId;
        let itemId = r.getValue({ name: 'internalid', join: 'CUSTRECORD_SGP_PRODUCT_CODE' });
        let key = itemId + '-' + custId;
        let key1 = itemId + '-' + parentId;
        let TY = tyMap[key] ? tyMap[key] : tyMap[key1] || 0;
        let ship = shipMap[key] ? shipMap[key] : shipMap[key1] || '';




        PBcases = PBcases == 'InfinityX' ? 0 : PBcases;
        PBUnits = PBUnits == 'InfinityX' ? 0 : PBUnits;
        prebook_cases_txt = prebook_cases_txt == 'InfinityX' ? '0' : prebook_cases_txt;

        let orderDt = r.getValue({ name: 'custrecord_sgp_order_date' }) || '';
        let recp = r.getValue({ name: 'entityid', join: 'CUSTRECORD_SGP_RECP_CUST' });
        if (CatTxt === 'BULK') recp = 'NONE';
        let custName = r.getValue({ name: 'custrecord_sgp_customer_name' });
        let custCode = r.getValue({ name: 'entityid', join: 'CUSTRECORD_SGP_CUST_CODE' });
        let parent = r.getText({ name: 'custentity_bc_parent_company', join: 'CUSTRECORD_SGP_CUST_CODE' }) || custName;


        let ccpp = ccppMap[key] ? ccppMap[key] : ccppMap[key1] || '';

        finalData.push({
          Account_Manager: AM,
          Product,
          Product_Description: Desc,
          Category_ID: CatTxt || 'None',
          prebook_season: Season,
          Pack: Pack,
          LY_Cases: `${LY}X${PBcases}`,
          LY_Units: LYUnits,
          Prebook_Cases: prebook_cases_txt,
          Prebook_Units: PBUnits,
          Status,
          TY_Units: TY,
          Order_Date: orderDt,
          shipDate: ship,
          Recp_Cust: recp,
          Customer_Code: custCode,
          Customer_Item_No: ccpp,
          Customer_Name: custName,
          Parent_Customer: parent,
          customer: custId,
          internalid: r.id,
          prebookStatus: PBStatus
        });
      });


      let csvData = '';



      if (action === 'product' || action === 'customer') {
        log.debug('Export Excel', { action: action, rows: finalData.length });

        const excelRows = [];


        excelRows.push([
          { value: 'Account Manager', style: 'hRight' },
          { value: 'Season', style: 'hRight' },
          { value: 'Product Code', style: 'hLeft' },
          { value: 'Customer Code', style: 'hCenter' },
          { value: 'Product Description', style: 'hRight' },
          { value: 'Pack', style: 'hRight' },
          { value: 'LY Cases', style: 'hRight' },
          { value: 'LY Units', style: 'hRight' },
          { value: 'Prebook Cases', style: 'hRight' },
          { value: 'Prebook Units', style: 'hRight' },
          { value: 'Status', style: 'hLeft' },
          { value: 'TY Units', style: 'hRight' },
          { value: 'Order Date', style: 'hRight' },
          { value: 'TY Ship Thru Date', style: 'hRight' },
          { value: 'Recp Cust', style: 'hRight' },
          { value: 'Child / Ship To', style: 'hLeft' }
        ]);

        finalData
          .sort(function (a, b) {
            const nameA = String(a.Customer_Name || '').trim();
            const nameB = String(b.Customer_Name || '').trim();

            if (nameA !== nameB) {
              return nameA.localeCompare(nameB);
            }

            const numA = getLeadingProductNumber(a.Product);
            const numB = getLeadingProductNumber(b.Product);

            if (numA !== numB) return numA - numB;
            return String(a.Product || '').localeCompare(String(b.Product || ''));
          })
          .forEach((item) => {
            excelRows.push([
              { value: item.Account_Manager || '', style: 'tRight' },
              { value: item.prebook_season || '', style: 'tRight' },
              { value: item.Product || '', style: 'tLeft' },
              { value: item.Customer_Code || '', style: 'tCenter' },
              { value: item.Product_Description || '', style: 'tRight' },
              { value: item.Pack || '', style: 'tRight' },
              { value: item.LY_Cases || '', style: 'tRight' },
              { value: item.LY_Units || 0, style: 'tRight' },
              { value: item.Prebook_Cases || '', style: 'tRight' },
              { value: item.Prebook_Units || 0, style: 'tRight' },
              { value: item.Status || '', style: 'tLeft' },
              { value: item.TY_Units || 0, style: 'tRight' },
              { value: item.Order_Date || '', style: 'tRight' },
              { value: item.shipDate || '', style: 'tRight' },
              { value: item.Recp_Cust || '', style: 'tRight' },
              { value: item.Customer_Name || '', style: 'tLeft' }
            ]);
          });

        let excelContent =
          '<?xml version="1.0"?>' +
          '<?mso-application progid="Excel.Sheet"?>' +
          '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
          'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
          'xmlns:x="urn:schemas-microsoft-com:office:excel" ' +
          'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" ' +
          'xmlns:html="http://www.w3.org/TR/REC-html40">' +

          '<Styles>' +

          '<Style ss:ID="hLeft">' +
          '<Font ss:Bold="1"/>' +
          '<Interior ss:Color="#D9EAF7" ss:Pattern="Solid"/>' +
          '<Borders>' +
          '<Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '</Borders>' +
          '<Alignment ss:Horizontal="Left" ss:Vertical="Center"/>' +
          '</Style>' +

          '<Style ss:ID="hCenter">' +
          '<Font ss:Bold="1"/>' +
          '<Interior ss:Color="#D9EAF7" ss:Pattern="Solid"/>' +
          '<Borders>' +
          '<Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '</Borders>' +
          '<Alignment ss:Horizontal="Center" ss:Vertical="Center"/>' +
          '</Style>' +

          '<Style ss:ID="hRight">' +
          '<Font ss:Bold="1"/>' +
          '<Interior ss:Color="#D9EAF7" ss:Pattern="Solid"/>' +
          '<Borders>' +
          '<Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '</Borders>' +
          '<Alignment ss:Horizontal="Right" ss:Vertical="Center"/>' +
          '</Style>' +

          '<Style ss:ID="tLeft">' +
          '<Borders>' +
          '<Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '</Borders>' +
          '<Alignment ss:Horizontal="Left" ss:Vertical="Center"/>' +
          '</Style>' +

          '<Style ss:ID="tCenter">' +
          '<Borders>' +
          '<Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '</Borders>' +
          '<Alignment ss:Horizontal="Center" ss:Vertical="Center"/>' +
          '</Style>' +

          '<Style ss:ID="tRight">' +
          '<Borders>' +
          '<Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '</Borders>' +
          '<Alignment ss:Horizontal="Right" ss:Vertical="Center"/>' +
          '</Style>' +

          '</Styles>' +

          '<Worksheet ss:Name="Export Report">' +
          '<Table>' +
          '<Column ss:Width="110"/>' +  // Account Manager
          '<Column ss:Width="90"/>' +   // Season
          '<Column ss:Width="100"/>' +  // Product Code
          '<Column ss:Width="100"/>' +  // Customer Code
          '<Column ss:Width="260"/>' +  // Product Description
          '<Column ss:Width="70"/>' +   // Pack
          '<Column ss:Width="90"/>' +   // LY Cases
          '<Column ss:Width="90"/>' +   // LY Units
          '<Column ss:Width="100"/>' +  // Prebook Cases
          '<Column ss:Width="100"/>' +  // Prebook Units
          '<Column ss:Width="90"/>' +   // Status
          '<Column ss:Width="80"/>' +   // TY Units
          '<Column ss:Width="90"/>' +   // Order Date
          '<Column ss:Width="100"/>' +  // TY Ship Thru Date
          '<Column ss:Width="90"/>' +   // Recp Cust
          '<Column ss:Width="180"/>';   // Child / Ship To

        excelRows.forEach(function (row) {
          excelContent += '<Row>';

          if (!row || !row.length) {
            excelContent += '<Cell><Data ss:Type="String"></Data></Cell>';
          } else {
            row.forEach(function (cell) {
              const val = (cell && cell.value !== null && cell.value !== undefined) ? String(cell.value) : '';
              const style = (cell && cell.style) ? cell.style : 'tLeft';
              const type = 'String';

              excelContent +=
                '<Cell ss:StyleID="' + style + '">' +
                '<Data ss:Type="' + type + '">' + escapeExcelXml(val) + '</Data>' +
                '</Cell>';
            });
          }

          excelContent += '</Row>';
        });

        excelContent +=
          '</Table>' +
          '</Worksheet>' +
          '</Workbook>';

        const fileObj = file.create({
          name: action === 'product'
            ? `${prebookname}_Product_Export_View.xls`
            : `${prebookname}_Customer_Export_View.xls`,
          fileType: file.Type.PLAINTEXT,
          contents: excelContent,
          folder: -15
        });

        scriptContext.response.writeFile({ file: fileObj, isInline: false });
        log.debug('Export Excel', 'File streamed to response');
        return;






      } else if (action === 'sales' || action === 'customersales') {
        log.debug('Sales Excel', { rows: finalData.length });

        const groupedData = groupBy(finalData, 'customer');

        let excelRows = [];

        Object.keys(groupedData)
          .sort(function (a, b) {
            const rowsA = groupedData[a] || [];
            const rowsB = groupedData[b] || [];

            const nameA = String((rowsA[0] && rowsA[0].Customer_Name) || '').trim();
            const nameB = String((rowsB[0] && rowsB[0].Customer_Name) || '').trim();

            return nameA.localeCompare(nameB);
          })
          .forEach((key) => {
            const rows = groupedData[key];
            const childShipTo = String((rows[0] && rows[0].Customer_Name) || '').trim();


            excelRows.push([
              { value: 'Name', style: 'hLeft' },
              { value: childShipTo, style: 'tLeft' }
            ]);


            excelRows.push([
              { value: 'Item Season', style: 'hLeft' },
              { value: 'Product Code', style: 'hLeft' },
              { value: 'Customer Item Number', style: 'hCenter' },
              { value: 'Product Description', style: 'hLeft' },
              { value: 'Pack', style: 'hLeft' },
              { value: 'LY Cases', style: 'hLeft' },
              { value: 'PreBook Cases', style: 'hLeft' },
              { value: 'TY Units', style: 'hLeft' }
            ]);

            rows
              .sort(function (a, b) {
                const numA = getLeadingProductNumber(a.Product);
                const numB = getLeadingProductNumber(b.Product);

                if (numA !== numB) return numA - numB;
                return String(a.Product || '').localeCompare(String(b.Product || ''));
              })
              .forEach((item) => {
                excelRows.push([
                  { value: item.prebook_season || '', style: 'tLeft' },  // Season right
                  { value: item.Product || '', style: 'tLeft' },  // Product left
                  { value: item.Customer_Item_No || '', style: 'tCenter' },  // CCPP center
                  { value: item.Product_Description || '', style: 'tLeft' },  // Desc right
                  { value: item.Pack || '', style: 'tLeft' },  // Pack left
                  { value: item.LY_Cases || '', style: 'tLeft' },  // LY Cases left
                  { value: item.Prebook_Cases || '', style: 'tLeft' },  // PreBook Cases left
                  { value: item.TY_Units || 0, style: 'tLeft' }   // TY Units left
                ]);
              });


            excelRows.push([]);
          });

        let excelContent =
          '<?xml version="1.0"?>' +
          '<?mso-application progid="Excel.Sheet"?>' +
          '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
          'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
          'xmlns:x="urn:schemas-microsoft-com:office:excel" ' +
          'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" ' +
          'xmlns:html="http://www.w3.org/TR/REC-html40">' +


          '<Styles>' +

          // HEADER STYLES (bold + blue fill + borders)
          '<Style ss:ID="hLeft">' +
          '<Font ss:Bold="1"/>' +
          '<Interior ss:Color="#D9EAF7" ss:Pattern="Solid"/>' +
          '<Borders>' +
          '<Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '</Borders>' +
          '<Alignment ss:Horizontal="Left" ss:Vertical="Center"/>' +
          '</Style>' +

          '<Style ss:ID="hCenter">' +
          '<Font ss:Bold="1"/>' +
          '<Interior ss:Color="#D9EAF7" ss:Pattern="Solid"/>' +
          '<Borders>' +
          '<Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '</Borders>' +
          '<Alignment ss:Horizontal="Center" ss:Vertical="Center"/>' +
          '</Style>' +

          '<Style ss:ID="hRight">' +
          '<Font ss:Bold="1"/>' +
          '<Interior ss:Color="#D9EAF7" ss:Pattern="Solid"/>' +
          '<Borders>' +
          '<Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '</Borders>' +
          '<Alignment ss:Horizontal="Right" ss:Vertical="Center"/>' +
          '</Style>' +


          '<Style ss:ID="tLeft">' +
          '<Borders>' +
          '<Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '</Borders>' +
          '<Alignment ss:Horizontal="Left" ss:Vertical="Center"/>' +
          '</Style>' +

          '<Style ss:ID="tCenter">' +
          '<Borders>' +
          '<Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '</Borders>' +
          '<Alignment ss:Horizontal="Center" ss:Vertical="Center"/>' +
          '</Style>' +

          '<Style ss:ID="tRight">' +
          '<Borders>' +
          '<Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '<Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>' +
          '</Borders>' +
          '<Alignment ss:Horizontal="Right" ss:Vertical="Center"/>' +
          '</Style>' +

          '</Styles>' +

          '<Worksheet ss:Name="Sales Report">' +
          '<Table>' +
          '<Column ss:Width="90"/>' +   // Item Season
          '<Column ss:Width="100"/>' +  // Product Code
          '<Column ss:Width="120"/>' +  // Customer Item Number
          '<Column ss:Width="260"/>' +  // Product Description
          '<Column ss:Width="60"/>' +   // Pack
          '<Column ss:Width="90"/>' +   // LY Cases
          '<Column ss:Width="110"/>' +  // PreBook Cases
          '<Column ss:Width="80"/>';    // TY Units

        excelRows.forEach(function (row) {
          excelContent += '<Row>';

          if (!row || !row.length) {
            excelContent += '<Cell><Data ss:Type="String"></Data></Cell>';
          } else {
            row.forEach(function (cell) {
              const val = (cell && cell.value !== null && cell.value !== undefined) ? String(cell.value) : '';
              const style = (cell && cell.style) ? cell.style : 'tLeft';


              const type = 'String';

              excelContent +=
                '<Cell ss:StyleID="' + style + '">' +
                '<Data ss:Type="' + type + '">' + escapeExcelXml(val) + '</Data>' +
                '</Cell>';
            });
          }

          excelContent += '</Row>';
        });

        excelContent +=
          '</Table>' +
          '</Worksheet>' +
          '</Workbook>';

        const fileObj = file.create({
          name: action === 'sales'
            ? `${prebookname}_Product_Sales_View.xls`
            : `${prebookname}_Customer_Sales_View.xls`,
          fileType: file.Type.PLAINTEXT,
          contents: excelContent,
          folder: -15
        });

        scriptContext.response.writeFile({ file: fileObj, isInline: false });
        log.debug('Sales Excel', 'File streamed to response');
        return;



      } else if (action === 'productpdf') {
        log.debug('Sales Customer Prebook Report CSV', { rows: finalData.length });
        let fileObj = render.create();
        let preBookObj = record.load({ type: 'customrecord_sgp_prebook', id: params.prebook });

        const groupedKey = 'Product';
        let content = [];
        const groupedData = groupBy(finalData, groupedKey);

        Object.keys(groupedData)
          .sort(function (a, b) {
            const numA = getLeadingProductNumber(a);
            const numB = getLeadingProductNumber(b);

            if (numA !== numB) {
              return numA - numB;
            }

            return String(a || '').localeCompare(String(b || ''));
          })
          .forEach((key) => {
            const rows = groupedData[key];
            let totalLYUnits = 0, totalPrebookUnits = 0, totalTYUnits = 0;

            rows
              .sort(function (a, b) {
                const nameA = String(a.Customer_Name || '').trim();
                const nameB = String(b.Customer_Name || '').trim();

                return nameA.localeCompare(nameB);
              })
              .forEach((item) => {
                totalLYUnits += Number(item.LY_Units || 0);
                totalPrebookUnits += Number(item.Prebook_Units || 0);
                totalTYUnits += Number(item.TY_Units || 0);

                const line = {
                  PRODUCT_CODE: item.Product,
                  PRODUCT_DESCRIPTION: excapeXML(item.Product_Description),
                  CATEGORY_ID: item.Category_ID,
                  L_Y_CASES: item.LY_Cases,
                  LY_UNITS: item.LY_Units,
                  PRE_BOOK_CASES: item.Prebook_Cases,
                  PREBOOK_UNITS: item.Prebook_Units,
                  STATUS: item.Status,
                  TY_UNITS: item.TY_Units,
                  ORDER_DATE: item.Order_Date,
                  RECP_CUST: item.Recp_Cust,
                  CUST_CODE: excapeXML(item.Customer_Code),
                  CUSTOMER_NAME: excapeXML(item.Customer_Name),
                  PARENT_CUSTOMER: excapeXML(item.Parent_Customer)
                };
                content.push(line);
              });

            const line = { PRODUCT_CODE: `<b>Total ${key}</b>`, LY_UNITS: totalLYUnits, PREBOOK_UNITS: totalPrebookUnits, TY_UNITS: totalTYUnits };
            content.push(line);
          });

        log.debug('content', content);
        fileObj.setTemplateById(159);
        fileObj.addRecord('record', preBookObj);
        fileObj.addCustomDataSource({
          format: render.DataSource.JSON,
          alias: 'data',
          data: JSON.stringify({ report: content, action: 'prebookreport' })
        });
        const pdfFile = fileObj.renderAsPdf();
        pdfFile.name = 'Sales_Customer_Prebook_Report.pdf';
        scriptContext.response.writeFile({ file: pdfFile, isInline: true });
        return;


      } else if (action === 'customerpdf') {
        log.debug('Sales Customer Prebook Report CSV', { rows: finalData.length });
        let fileObj = render.create();
        let preBookObj = record.load({ type: 'customrecord_sgp_prebook', id: params.prebook });

        const groupedKey = 'customer';
        let content = [];
        const groupedData = groupBy(finalData, groupedKey);
        log.debug('groupedData', groupedData);
        Object.keys(groupedData)
          .sort(function (a, b) {
            const rowsA = groupedData[a] || [];
            const rowsB = groupedData[b] || [];

            const nameA = String((rowsA[0] && rowsA[0].Customer_Name) || '').trim();
            const nameB = String((rowsB[0] && rowsB[0].Customer_Name) || '').trim();

            return nameA.localeCompare(nameB);
          })
          .forEach((key) => {
            const rows = groupedData[key];
            let totalLYUnits = 0, totalPrebookUnits = 0, totalTYUnits = 0;
            let customerName = '';

            rows
              .sort(function (a, b) {
                const numA = getLeadingProductNumber(a.Product);
                const numB = getLeadingProductNumber(b.Product);

                if (numA !== numB) {
                  return numA - numB;
                }

                return String(a.Product || '').localeCompare(String(b.Product || ''));
              })
              .forEach((item) => {
                totalLYUnits += Number(item.LY_Units || 0);
                totalPrebookUnits += Number(item.Prebook_Units || 0);
                totalTYUnits += Number(item.TY_Units || 0);
                const line = {
                  PRODUCT_CODE: item.Product,
                  PRODUCT_DESCRIPTION: excapeXML(item.Product_Description),
                  ITEM_SEASON: excapeXML(item.prebook_season || ''),
                  CATEGORY_ID: item.Category_ID,
                  L_Y_CASES: item.LY_Cases,
                  LY_UNITS: item.LY_Units,
                  Customer_Item_No: item.Customer_Item_No,
                  PRE_BOOK_CASES: item.Prebook_Cases,
                  PREBOOK_UNITS: item.Prebook_Units,
                  STATUS: item.Status,
                  TY_UNITS: item.TY_Units,
                  ORDER_DATE: item.Order_Date,
                  RECP_CUST: item.Recp_Cust,
                  CUST_CODE: excapeXML(item.Customer_Code),
                  CUSTOMER_NAME: excapeXML(item.Customer_Name),
                  PARENT_CUSTOMER: excapeXML(item.Parent_Customer)
                };
                customerName = excapeXML(item.Customer_Name);
                content.push(line);
              });

            const line = { PRODUCT_DESCRIPTION: `${customerName} <b>Total</b>`, LY_UNITS: totalLYUnits, PREBOOK_UNITS: totalPrebookUnits, TY_UNITS: totalTYUnits };
            content.push(line);
          });

        log.debug('content', content);
        fileObj.setTemplateById(159);
        fileObj.addRecord('record', preBookObj);
        fileObj.addCustomDataSource({
          format: render.DataSource.JSON,
          alias: 'data',
          data: JSON.stringify({ report: content, action: 'cusromerpdf' })
        });
        const pdfFile = fileObj.renderAsPdf();
        pdfFile.name = 'Sales_Customer_Prebook_Report.pdf';
        scriptContext.response.writeFile({ file: pdfFile, isInline: true });
        return;



      } else if (action === 'producatsalespdf') {
        log.debug('Product Sales PDF', { rows: finalData.length });
        let fileObj = render.create();
        let preBookObj = record.load({ type: 'customrecord_sgp_prebook', id: params.prebook });

        let content = [];
        const groupedData = groupBy(finalData, 'Product');

        Object.keys(groupedData)
          .sort(function (a, b) {
            const numA = getLeadingProductNumber(a);
            const numB = getLeadingProductNumber(b);

            if (numA !== numB) {
              return numA - numB;
            }

            return String(a || '').localeCompare(String(b || ''));
          })
          .forEach((key) => {
            const rows = groupedData[key];
            let count = 0;

            rows
              .sort(function (a, b) {
                const nameA = String(a.Customer_Name || '').trim();
                const nameB = String(b.Customer_Name || '').trim();
                return nameA.localeCompare(nameB);
              })
              .forEach((item) => {
                if (count == 0) {
                  const line = {
                    PRODUCT_CODE: `<b>${item.Product || ''}</b>`,
                    PRODUCT_DESCRIPTION: `<b>${excapeXML(item.Product_Description || '')}</b>`
                  };
                  content.push(line);
                }

                const line = {
                  PRODUCT_CODE: item.Product,
                  PRODUCT_DESCRIPTION: excapeXML(item.Product_Description),
                  CATEGORY_ID: item.Category_ID,
                  L_Y_CASES: item.LY_Cases,
                  PRE_BOOK_CASES: item.Prebook_Cases,
                  CUST_CODE: excapeXML(item.Customer_Code),
                  CUSTOMER_NAME: excapeXML(item.Customer_Name)
                };
                content.push(line);
                count++;
              });
          });

        log.debug('Product Sales PDF content', content);
        fileObj.setTemplateById(159);
        fileObj.addRecord('record', preBookObj);
        fileObj.addCustomDataSource({
          format: render.DataSource.JSON,
          alias: 'data',
          data: JSON.stringify({
            report: content,
            action: 'producatsalespdf'
          })
        });

        const pdfFile = fileObj.renderAsPdf();
        pdfFile.name = 'Product_Sales_Report.pdf';
        scriptContext.response.writeFile({ file: pdfFile, isInline: true });
        return;



      } else if (action === 'customersalespdf') {
        log.debug('Customer Sales PDF', { rows: finalData.length });
        let fileObj = render.create();
        let preBookObj = record.load({ type: 'customrecord_sgp_prebook', id: params.prebook });

        let content = [];
        const groupedData = groupBy(finalData, 'customer');

        Object.keys(groupedData)
          .sort(function (a, b) {
            const rowsA = groupedData[a] || [];
            const rowsB = groupedData[b] || [];

            const nameA = String((rowsA[0] && rowsA[0].Customer_Name) || '').trim();
            const nameB = String((rowsB[0] && rowsB[0].Customer_Name) || '').trim();

            return nameA.localeCompare(nameB);
          })
          .forEach((key) => {
            const rows = groupedData[key];
            let count = 0;

            rows
              .sort(function (a, b) {
                const numA = getLeadingProductNumber(a.Product);
                const numB = getLeadingProductNumber(b.Product);

                if (numA !== numB) {
                  return numA - numB;
                }

                return String(a.Product || '').localeCompare(String(b.Product || ''));
              })
              .forEach((item) => {
                if (count == 0) {
                  const line = {
                    PRODUCT_CODE: 'Total',
                    PRODUCT_DESCRIPTION: `<b>${excapeXML(item.Customer_Name || '')}</b>`
                  };
                  content.push(line);
                }

                const line = {
                  PRODUCT_CODE: item.Product,
                  Customer_Item_No: item.Customer_Item_No,
                  PRODUCT_DESCRIPTION: excapeXML(item.Product_Description),
                  CATEGORY_ID: item.Category_ID,
                  L_Y_CASES: item.LY_Cases,
                  PRE_BOOK_CASES: item.Prebook_Cases,
                  CUST_CODE: excapeXML(item.Customer_Code),
                  CUSTOMER_NAME: excapeXML(item.Customer_Name)
                };
                content.push(line);
                count++;
              });
          });

        log.debug('Customer Sales PDF content', content);
        fileObj.setTemplateById(159);
        fileObj.addRecord('record', preBookObj);
        fileObj.addCustomDataSource({
          format: render.DataSource.JSON,
          alias: 'data',
          data: JSON.stringify({
            report: content,
            action: 'customersalespdf'
          })
        });

        const pdfFile = fileObj.renderAsPdf();
        pdfFile.name = 'Customer_Sales_Report.pdf';
        scriptContext.response.writeFile({ file: pdfFile, isInline: true });
        return;


      } else if (action === 'summarycategorypdf') {
        log.debug('Summary Category PDF', { rows: finalData.length });

        let fileObj = render.create();
        let preBookObj = record.load({
          type: 'customrecord_sgp_prebook',
          id: params.prebook
        });


        let groupedByCat = groupBy(finalData, 'Category_ID');
        let content = [];


        let grandPrebookUnits = 0;
        let grandTyUnits = 0;
        let grandLyUnits = 0;
        const ordered = Object.keys(groupedByCat).sort(function (a, b) {
          return getLeadingCategoryNumber(a) - getLeadingCategoryNumber(b);
        });
        ordered.forEach(function (catKey) {
          // if(catKey!='None-'){
          const catName = catKey || 'None';
          const rowsCat = groupedByCat[catKey];
          log.debug('ordered', ordered);


          const byProduct = {};
          rowsCat.forEach(function (item) {
            const code = item.Product || '(No Code)';
            if (!byProduct[code]) {
              byProduct[code] = {
                code: item.Product || '',
                desc: item.Product_Description || '',
                prebook: 0,
                ty: 0,
                LY: 0
              };
            }
            byProduct[code].prebook += Number(item.Prebook_Units || 0);
            byProduct[code].ty += Number(item.TY_Units || 0);
            byProduct[code].LY += Number(item.LY_Units || 0);


          });

          let catPrebookUnits = 0;
          let catTyUnits = 0;
          let catLyUnits = 0;

          Object.keys(byProduct)
            .sort(function (a, b) {
              const numA = getLeadingProductNumber(a);
              const numB = getLeadingProductNumber(b);

              if (numA !== numB) {
                return numA - numB;
              }

              return String(a).localeCompare(String(b));
            })
            .forEach(function (codeKey) {
              const agg = byProduct[codeKey];
              const prebk = agg.prebook;
              const ty = agg.ty;
              const diff = prebk - ty;
              const lY = agg.LY;

              catPrebookUnits += prebk;
              catTyUnits += ty;
              catLyUnits += lY;
              grandPrebookUnits += prebk;
              grandTyUnits += ty;
              grandLyUnits += (lY || 0);

              content.push({
                CATEGORY_ID: catName,
                PRODUCT_CODE: agg.code,
                LY_UNITS: lY,
                PRODUCT_DESCRIPTION: excapeXML(agg.desc || ''),
                PREBOOK_UNITS: prebk,
                TY_UNITS: ty,
                DIFF_UNITS: diff
              });
            });


          const catDiff = catPrebookUnits - catTyUnits;
          content.push({
            CATEGORY_ID: catName + ' Total',
            PRODUCT_CODE: '',
            LY_UNITS: catLyUnits,
            PRODUCT_DESCRIPTION: '',
            PREBOOK_UNITS: catPrebookUnits,
            TY_UNITS: catTyUnits,
            DIFF_UNITS: catDiff
          });



        });


        const grandDiff = grandPrebookUnits - grandTyUnits;
        content.push({
          CATEGORY_ID: 'Grand Total',
          PRODUCT_CODE: '',
          PRODUCT_DESCRIPTION: '',
          LY_UNITS: grandLyUnits,
          PREBOOK_UNITS: grandPrebookUnits,
          TY_UNITS: grandTyUnits,
          DIFF_UNITS: grandDiff
        });

        log.debug('Summary content', content);

        fileObj.setTemplateById(159);
        fileObj.addRecord('record', preBookObj);
        fileObj.addCustomDataSource({
          format: render.DataSource.JSON,
          alias: 'data',
          data: JSON.stringify({
            report: content,
            action: 'summarycategorypdf'
          })
        });

        const pdfFile = fileObj.renderAsPdf();
        pdfFile.name = 'Prebook_Summary_By_Category.pdf';
        scriptContext.response.writeFile({
          file: pdfFile,
          isInline: true
        });
        return;

      } else {
        // No action matched
        log.debug('CSV Exit', 'Unknown action: ' + action);
        return;
      }
    };



    function groupBy(objectArray, property) {
      return objectArray.reduce((acc, obj) => {
        const key = obj[property];
        if (!acc[key]) acc[key] = [];
        acc[key].push(obj);
        return acc;
      }, {});
    }

    function getLeadingCategoryNumber(value) {
      if (!value) return Number.MAX_SAFE_INTEGER;
      const str = String(value).trim();
      const match = str.match(/^(\d+)/);
      return match ? parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
    }

    function getLeadingProductNumber(value) {
      if (!value) return Number.MAX_SAFE_INTEGER;
      const str = String(value).trim();
      const match = str.match(/^(\d+(\.\d+)?)/);
      return match ? parseFloat(match[1]) : Number.MAX_SAFE_INTEGER;
    }

    const getprebook = (params) => {
      const f = [];
      if (params.prebook) {
        f.push(search.createFilter({
          name: 'custrecord_sgp_prebook_id_detail',
          operator: 'anyof',
          values: [params.prebook]
        }));
      }

      if (params.accountmanager) {
        f.push(search.createFilter({
          name: 'salesrep',
          join: 'CUSTRECORD_SGP_CUST_CODE',
          operator: 'anyof',
          values: [params.accountmanager]
        }));
      }

      if (params.salessupport) {
        f.push(search.createFilter({
          name: 'custentity_sgp_sales_support',
          join: 'CUSTRECORD_SGP_CUST_CODE',
          operator: 'anyof',
          values: [params.salessupport]
        }));
      }

      if (params.year) {
        f.push(search.createFilter({
          name: 'custrecord_year',
          join: 'CUSTRECORD_SGP_PREBOOK_ID_DETAIL',
          operator: 'anyof',
          values: [params.year]
        }));
      }

      if (params.productcode) {
        f.push(search.createFilter({
          name: 'custrecord_sgp_product_code',
          operator: 'anyof',
          values: [params.productcode]
        }));
      }
      log.debug('getprebook params', {
        prebook: params.prebook || '',
        year: params.year || '',
        accountmanager: params.accountmanager || '',
        salessupport: params.salessupport || '',
        productcode: params.productcode || '',
        catid: params.catid || '',
        childcustomer: params.childcustomer || '',
        parentcustomer: params.parentcustomer || ''
      });


      if (params.catid) {
        f.push(search.createFilter({
          name: 'custitem_sgp_subcategory',
          join: 'CUSTRECORD_SGP_PRODUCT_CODE',
          operator: 'anyof',
          values: [params.catid]
        }));
      }

      if (params.childcustomer) {
        f.push(search.createFilter({
          name: 'custrecord_sgp_cust_code',
          operator: 'anyof',
          values: [params.childcustomer]
        }));
      }

      if (params.parentcustomer) {
        f.push(search.createFilter({
          name: 'custentity_bc_parent_company',
          join: 'CUSTRECORD_SGP_CUST_CODE',
          operator: 'anyof',
          values: [params.parentcustomer]
        }));
      }

      log.debug('getprebook filters count', f.length);
      log.debug('getprebook childcustomer', params.childcustomer || '');
      log.debug('getprebook parentcustomer', params.parentcustomer || '');

      const rpSearchObj = search.create({
        type: 'customrecord_sgp_prebook_projection_rp',
        filters: f,
        columns: [
          search.createColumn({ name: 'internalid', label: 'INTERNALID' }),
          search.createColumn({ name: 'custrecord_sgp_prebook_id_detail', label: 'SGP_PREBOOK_ID' }),
          search.createColumn({ name: 'mpn', join: 'CUSTRECORD_SGP_PRODUCT_CODE', label: 'PRODUCT_CODE', sort: search.Sort.ASC }),
          search.createColumn({ name: 'displayname', join: 'CUSTRECORD_SGP_PRODUCT_CODE', label: 'PRODUCT_DESCRIPTION' }),
          search.createColumn({ name: 'custitem_cseg_sgp_prodseason', join: 'CUSTRECORD_SGP_PRODUCT_CODE', label: 'ITEM_SEASON' }),
          search.createColumn({ name: 'custitem_sgp_packing', join: 'CUSTRECORD_SGP_PRODUCT_CODE', label: 'PACK' }),


          search.createColumn({ name: 'custitem_cseg_sgp_prod_cat', join: 'CUSTRECORD_SGP_PRODUCT_CODE', label: 'CATEGORY_ID' }),


          search.createColumn({
            name: 'custitem_sgp_subcategory',
            join: 'CUSTRECORD_SGP_PRODUCT_CODE',
            label: 'ITEM_SUBCATEGORY2'
          }),

          search.createColumn({ name: 'internalid', label: 'RPT_SEQN' }),
          search.createColumn({ name: 'custrecord_sgp_psubcat_id', join: 'CUSTRECORD_SGP_CAT_ID', label: 'CAT_ID' }),
          search.createColumn({ name: 'custrecord_sgp_ly_cases', label: 'L_Y_CASES' }),
          search.createColumn({ name: 'formulatext', formula: "CASE WHEN {custrecord_sgp_product_code.unitstype} LIKE 'CASE' THEN {custrecord_sgp_ly_cases}* {custrecord_sgp_product_code.custitem_sgp_packing} ELSE {custrecord_sgp_ly_cases} END", label: 'LY_UNITS' }),
          search.createColumn({ name: 'formulatext', formula: "CASE {custrecord_sgp_edit_custom} WHEN 'T' THEN '*'   ELSE '' END", label: 'ASTERISK' }),
          search.createColumn({ name: 'custrecord_sgp_prebook_cases_txt', label: 'PRE_BOOK_CASES' }),
          search.createColumn({ name: 'custrecord_sgp_prebook_qty', label: 'PREBOOK_UNITS' }),
          search.createColumn({ name: 'custrecord_sgp_excess_lyqty', label: 'EMPY' }),


          search.createColumn({ name: 'custrecord_sgp_ty_qty', label: 'TY_UNITS' }),

          search.createColumn({ name: 'custrecord_sgp_order_date', label: 'ORDER_DATE' }),
          search.createColumn({ name: 'entityid', join: 'CUSTRECORD_SGP_RECP_CUST', label: 'RECP_CUST' }),
          search.createColumn({ name: 'entityid', join: 'CUSTRECORD_SGP_CUST_CODE', label: 'CUST_CODE' }),
          search.createColumn({ name: 'custrecord_sgp_cust_code', label: 'CUST_CODE' }),
          search.createColumn({ name: 'salesrep', join: 'CUSTRECORD_SGP_CUST_CODE', label: 'ACCOUNT_MANAGER' }),
          search.createColumn({ name: 'custrecord_sgp_customer_name', label: 'CUSTOMER_NAME' }),
          search.createColumn({ name: 'internalid', join: 'CUSTRECORD_SGP_PRODUCT_CODE', label: 'ITEMID' }),
          search.createColumn({ name: 'mpn', join: 'CUSTRECORD_SGP_PRODUCT_CODE', label: '_ORDER' }),
          search.createColumn({ name: 'formulatext', formula: "REGEXP_SUBSTR(REPLACE({custrecord_sgp_prebook_cases_txt},'x','X'), '[^X]+', 1, 2)", label: 'PACK' }),
          search.createColumn({ name: 'entityid', join: 'CUSTRECORD_SGP_CUST_CODE', label: 'CUST_CODE' }),
          search.createColumn({ name: 'formulatext', formula: "NVL({custrecord_sgp_cust_code.custentity_bc_parent_company},{custrecord_sgp_customer_name})", label: 'PARENT_CUSTOMER' }),
          search.createColumn({ name: 'custentity_bc_parent_company', join: 'CUSTRECORD_SGP_CUST_CODE', label: 'PARENT_CUSTOMER_ENTITY' }),
          search.createColumn({ name: 'formulanumeric', formula: "NVL({custrecord_sgp_approval_status.id},0)", label: 'APPROVAL_STATUS' }),
          search.createColumn({ name: 'custrecord_sgp_prebook_cases', label: 'SGP PRE CAS PACK' }),
          search.createColumn({ name: 'custrecord_sgp_product_code', label: 'SGP PRE CAS PACK' }),
          search.createColumn({ name: 'custrecord_sgp_ly_qty', label: 'SGP PRE CAS PACK' })
        ]
      });
      return rpSearchObj.runPaged({ pageSize: 500 });
    };

    function getAllResults(pagedData, pageindex) {
      const resultDetails = [];
      if (pageindex) {
        const myPage = pagedData.fetch({ index: pageindex });
        myPage.data.forEach((r) => resultDetails.push(r));
      } else {
        pagedData.pageRanges.forEach((pageRange) => {
          const myPage = pagedData.fetch({ index: pageRange.index });
          myPage.data.forEach((r) => resultDetails.push(r));
        });
      }
      return resultDetails;
    }

    function getCustomerItemNumber(custIds, itemIds) {
      if (!custIds || !itemIds || !custIds.length || !itemIds.length) return {};
      const s = search.create({
        type: 'customrecord_sgp_cpp',
        filters: [
          ['custrecord_sgp_cpp_customerid', 'anyof'].concat(custIds), 'AND',
          ['custrecord_sgp_cpp_productid', 'anyof'].concat(itemIds)
        ],
        columns: [
          search.createColumn({ name: 'custrecord_sgp_cpp_custitemnumb' }),
          search.createColumn({ name: 'custrecord_sgp_cpp_customerid' }),
          search.createColumn({ name: 'custrecord_sgp_cpp_productid' })
        ]
      });
      const map = {};
      const paged = s.runPaged({ pageSize: 1000 });
      for (let i = 0; i < paged.pageRanges.length; i++) {
        const page = paged.fetch({ index: i });
        page.data.forEach(r => {
          const cust = r.getValue({ name: 'custrecord_sgp_cpp_customerid' });
          const item = r.getValue({ name: 'custrecord_sgp_cpp_productid' });
          const num = r.getValue({ name: 'custrecord_sgp_cpp_custitemnumb' });
          map[item + '-' + cust] = num;
        });
      }
      return map;
    }


    function excapeXML(si) {
      var s = new String(si);
      return s.replace(/&/g, "&amp;").replace(/&amp;lt;/g, "<").replace(/</g, "&lt;").replace(/&amp;gt;/g, ">").replace(/>/g, "&gt;");
    }
    const getsubcategory = () => {
      var subcategorySearchObj = search.create({
        type: "customrecord_sgp_subcategory",
        filters: [],
        columns:
          [
            search.createColumn({ name: "name", label: "Name" }),
            search.createColumn({ name: "scriptid", label: "Script ID" }),
            search.createColumn({ name: "custrecord_sgp_code", label: "SGP CODE" })
          ]
      });
      var searchResultCount = subcategorySearchObj.runPaged().count;
      log.debug("subcategorySearchObj result count", searchResultCount);
      let subcategory = {};
      subcategorySearchObj.run().each(function (result) {
        subcategory[result.id] = result.getValue({ name: 'custrecord_sgp_code' });
        return true;
      });
      return subcategory;
    }
    function nsDate(d) {
      if (!d) return '';
      const dt = (d instanceof Date) ? d : new Date(d);
      const m = (dt.getMonth() + 1).toString().padStart(2, '0');
      const day = dt.getDate().toString().padStart(2, '0');
      const y = dt.getFullYear();
      return m + '/' + day + '/' + y;
    }
    function escapeExcelXml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    }
    function buildTyMapForPage(opts) {
      const itemIds = Array.from(new Set((opts.itemIds || []).filter(Boolean)));
      const custIds = Array.from(new Set((opts.customerIds || []).filter(Boolean)));
      const filters = [['type', 'anyof', 'SalesOrd'], 'AND', ['mainline', 'is', 'F'], 'AND', ['status', 'anyof'].concat(TY_SO_STATUSES)];
      if (opts.start) filters.push('AND', ['trandate', 'onorafter', nsDate(opts.start)]);
      if (opts.end) filters.push('AND', ['trandate', 'onorbefore', nsDate(opts.end)]);
      if (itemIds.length) filters.push('AND', ['item', 'anyof'].concat(itemIds));
      if (custIds.length) filters.push('AND', ['entity', 'anyof'].concat(custIds));
      log.debug('filters', filters);
      const s = search.create({
        type: search.Type.TRANSACTION,
        filters,
        columns: [
          search.createColumn({ name: 'internalid', join: 'item', summary: search.Summary.GROUP }),
          search.createColumn({ name: 'internalid', join: 'customer', summary: search.Summary.GROUP }),
          search.createColumn({ name: 'quantity', summary: 'SUM' })
        ]
      });
      log.debug('search', s)
      const map = {};
      const paged = s.runPaged({ pageSize: 1000 });
      for (let i = 0; i < paged.pageRanges.length; i++) {
        const page = paged.fetch({ index: i });
        page.data.forEach(r => {
          const itemId = r.getValue({ name: 'internalid', join: 'item', summary: search.Summary.GROUP });
          const custId = r.getValue({ name: 'internalid', join: 'customer', summary: search.Summary.GROUP });
          const qty = Number(r.getValue({ name: 'quantity', summary: 'SUM' })) || 0;
          if (itemId && custId) {
            const key = itemId + '-' + custId;
            map[key] = (map[key] || 0) + qty;
          }
        });
      }
      log.debug('map', map);
      return map;
    }
    const getShipDate = (opts) => {
      const itemIds = Array.from(new Set((opts.itemIds || []).filter(Boolean)));
      const custIds = Array.from(new Set((opts.customerIds || []).filter(Boolean)));
      const filters = [['type', 'anyof', 'SalesOrd'], 'AND', ['mainline', 'is', 'F'], 'AND', ['status', 'anyof'].concat(TY_SO_STATUSES)];
      if (opts.start) filters.push('AND', ['trandate', 'onorafter', nsDate(opts.start)]);
      if (opts.end) filters.push('AND', ['trandate', 'onorbefore', nsDate(opts.end)]);
      if (itemIds.length) filters.push('AND', ['item', 'anyof'].concat(itemIds));
      if (custIds.length) filters.push('AND', ['entity', 'anyof'].concat(custIds));

      const s = search.create({
        type: 'salesorder',
        filters,
        columns: [
          search.createColumn({ name: 'entity', summary: 'GROUP' }),
          search.createColumn({ name: 'item', summary: 'GROUP' }),
          search.createColumn({ name: 'shipdate', summary: 'MAX' })
        ]
      });
      const map = {};
      const pg = s.runPaged({ pageSize: 1000 });
      for (let i = 0; i < pg.pageRanges.length; i++) {
        const page = pg.fetch({ index: i });
        page.data.forEach(r => {
          const cust = r.getValue({ name: 'entity', summary: 'GROUP' });
          const item = r.getValue({ name: 'item', summary: 'GROUP' });
          const ship = r.getValue({ name: 'shipdate', summary: 'MAX' });
          map[item + '-' + cust] = ship;
        });
      }
      return map;
    };

    return { onRequest };
  });

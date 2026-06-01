/**
 * Prior Sales Research - Serverless Function
 * Parses QuickSource HTML files and checks prior sales disclosures
 */

exports.handler = async (event) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }
  
  try {
    const { html } = JSON.parse(event.body);
    
    if (!html) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'No HTML content provided' })
      };
    }
    
    const result = analyzeQuickSource(html);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result)
    };
    
  } catch (err) {
    console.error('Prior sales error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || 'Analysis failed' })
    };
  }
};

function analyzeQuickSource(htmlContent) {
  // Extract JSON from HTML
  const jsonMatch = htmlContent.match(/<script type="application\/json">\s*(\[.*?\])\s*<\/script>/s);
  if (!jsonMatch) {
    throw new Error('Could not find QuickSource data in HTML file. Make sure this is a QuickSource HTML export from TOTAL.');
  }
  
  let data;
  try {
    data = JSON.parse(jsonMatch[1]);
  } catch (e) {
    throw new Error('Failed to parse QuickSource data: ' + e.message);
  }
  
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('No property data found in QuickSource file.');
  }
  
  const today = new Date();
  
  // Find subject and comps
  let subjectRecord = null;
  const compRecords = [];
  
  for (const record of data) {
    if (isSubject(record)) {
      subjectRecord = record;
    } else {
      compRecords.push(record);
    }
  }
  
  if (!subjectRecord) {
    throw new Error('No subject property found in data (missing ADDRESSVALIDATED marker).');
  }
  
  const subjectAddress = getFullAddress(subjectRecord);
  
  // Subject dates
  const subjectTransfer = subjectRecord.transfer || {};
  const subjectDates = parseDateField(subjectTransfer.DT_SALTIM1 || '');
  
  // Effective date: use settlement if available, else today
  let effectiveDate = subjectDates.settlementDate || today;
  let effectiveDateNote = subjectDates.settlementDate
    ? `Subject effective date: ${formatDate(effectiveDate)}`
    : `Effective date (defaulted to date of analysis): ${formatDate(effectiveDate)}`;
  
  const threeYearsAgo = new Date(effectiveDate);
  threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
  
  // Check subject sales history
  const subjectSalesHistory = subjectRecord.salesHistory || [];
  const subjectFlags = [];
  
  for (const sale of subjectSalesHistory) {
    const saleDate = parseIsoDate(sale.saleDate);
    const price = parsePrice(sale.price);
    
    // Skip anomalies
    if (!saleDate) continue;
    if (price === 870000) continue; // Known CoreLogic data anomaly
    
    // Check if within 3-year window
    if (saleDate >= threeYearsAgo && saleDate < effectiveDate) {
      subjectFlags.push({
        date: formatDate(saleDate),
        price: formatPrice(price),
        document_type: titleCase(sale.documentType || 'Unknown'),
        arms_length: sale.armsLength !== false,
        grantor: sale.grantor || '',
        grantee: sale.grantee || ''
      });
    }
  }
  
  // Check comps
  const compFlags = [];
  const pendingFlags = [];
  
  for (const comp of compRecords) {
    const compTransfer = comp.transfer || {};
    const compAddress = getShortAddress(comp);
    const compSalePrice = parsePrice(compTransfer.PR_SALEPR1 || '0');
    
    const compDates = parseDateField(compTransfer.DT_SALTIM1 || '');
    
    // Skip active listings
    if (compDates.isActive) continue;
    
    let settlementDate = compDates.settlementDate;
    let contractDate = compDates.contractDate || settlementDate;
    
    if (!contractDate) continue;
    
    const twelveMonthsPrior = new Date(contractDate);
    twelveMonthsPrior.setFullYear(twelveMonthsPrior.getFullYear() - 1);
    
    const salesHistory = comp.salesHistory || [];
    
    for (const sale of salesHistory) {
      const saleDate = parseIsoDate(sale.saleDate);
      const price = parsePrice(sale.price);
      
      // Skip anomalies
      if (!saleDate) continue;
      if (price === 870000) continue;
      
      // Skip the comp's own sale (within $1,000)
      if (Math.abs(price - compSalePrice) <= 1000) continue;
      
      // Check 12-month prior window
      if (saleDate >= twelveMonthsPrior && saleDate < contractDate) {
        compFlags.push({
          address: compAddress,
          date: formatDate(saleDate),
          price: formatPrice(price),
          document_type: titleCase(sale.documentType || 'Unknown'),
          arms_length: sale.armsLength !== false,
          grantor: sale.grantor || '',
          grantee: sale.grantee || ''
        });
      }
      
      // Check pending period
      if (settlementDate && saleDate >= contractDate && saleDate <= settlementDate) {
        pendingFlags.push({
          address: compAddress,
          date: formatDate(saleDate),
          price: formatPrice(price),
          document_type: titleCase(sale.documentType || 'Unknown'),
          arms_length: sale.armsLength !== false,
          grantor: sale.grantor || '',
          grantee: sale.grantee || ''
        });
      }
    }
  }
  
  // Build paragraph
  const paragraphLines = [];
  
  // Subject paragraph
  if (subjectFlags.length > 0) {
    const transferParts = subjectFlags.map(flag => {
      const armsNote = flag.arms_length ? '' : ' (non-arms-length)';
      return `transferred on ${flag.date} for ${flag.price} via a ${flag.document_type}${armsNote}`;
    });
    paragraphLines.push(
      `The subject property ${transferParts.join(' and ')} within the three years prior to the effective date of this appraisal.`
    );
  } else {
    paragraphLines.push(
      'The subject property has not transferred in the three years prior to the effective date of this appraisal.'
    );
  }
  
  // Comp paragraph
  if (compFlags.length > 0) {
    const byAddress = {};
    for (const flag of compFlags) {
      if (!byAddress[flag.address]) byAddress[flag.address] = [];
      byAddress[flag.address].push(flag);
    }
    
    const parts = Object.entries(byAddress).map(([addr, flags]) => {
      const flagStrs = flags.map(flag => {
        const armsNote = flag.arms_length ? '' : ' (non-arms-length)';
        return `on ${flag.date} for ${flag.price} via a ${flag.document_type}${armsNote}`;
      });
      return `${addr} previously transferred ${flagStrs.join(' and ')}`;
    });
    
    paragraphLines.push(
      `Of the comparable sales shown in this report, ${parts.join('; and ')}.`
    );
  } else {
    paragraphLines.push(
      'None of the comparable sales shown in this report transferred within the 12-month period prior to the date of sale used in this analysis.'
    );
  }
  
  // Pending notes
  for (const flag of pendingFlags) {
    paragraphLines.push(
      `Note: ${flag.address} had a ${flag.document_type} for ${flag.price} on ${flag.date} during the pending period.`
    );
  }
  
  return {
    subject_address: subjectAddress,
    effective_date_note: effectiveDateNote,
    paragraph: paragraphLines.join('\n\n'),
    subject_flags: subjectFlags,
    comp_flags: compFlags,
    pending_flags: pendingFlags
  };
}

function isSubject(record) {
  return record.transfer && 'ADDRESSVALIDATED' in record.transfer;
}

function getFullAddress(record) {
  const t = record.transfer || {};
  const addr1 = t.AD_ADDR1 || '';
  const city = t.DB_CITY || '';
  const state = t.DB_STATE || 'AR';
  const zip = t.DB_ZIPCODE || '';
  
  if (city) {
    return `${addr1}, ${city}, ${state} ${zip}`.trim();
  }
  return addr1;
}

function getShortAddress(record) {
  const t = record.transfer || {};
  const addr1 = t.AD_ADDR1 || '';
  const city = t.DB_CITY || '';
  if (city) {
    return `${addr1}, ${city}`;
  }
  return addr1;
}

function parseDateField(dtSaltim) {
  if (!dtSaltim || dtSaltim.trim() === '') {
    return { settlementDate: null, contractDate: null, isActive: false };
  }
  
  dtSaltim = dtSaltim.trim();
  
  if (dtSaltim.toLowerCase() === 'active') {
    return { settlementDate: null, contractDate: null, isActive: true };
  }
  
  // s/c format: "s03/25;c02/25"
  const scMatch = dtSaltim.match(/^s(\d{2})\/(\d{2});c(\d{2})\/(\d{2})$/);
  if (scMatch) {
    const [, sMonth, sYear, cMonth, cYear] = scMatch;
    const sYearFull = 2000 + parseInt(sYear);
    const cYearFull = 2000 + parseInt(cYear);
    
    // Settlement = last day of month
    const settlementDate = new Date(sYearFull, parseInt(sMonth), 0); // Day 0 = last day of previous month
    
    // Contract = first day of month
    const contractDate = new Date(cYearFull, parseInt(cMonth) - 1, 1);
    
    return { settlementDate, contractDate, isActive: false };
  }
  
  // Settlement only: "s03/26"
  const sOnlyMatch = dtSaltim.match(/^s(\d{2})\/(\d{2})$/);
  if (sOnlyMatch) {
    const [, sMonth, sYear] = sOnlyMatch;
    const sYearFull = 2000 + parseInt(sYear);
    const settlementDate = new Date(sYearFull, parseInt(sMonth), 0);
    return { settlementDate, contractDate: null, isActive: false };
  }
  
  // Single date: "03/15/2026"
  const singleMatch = dtSaltim.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (singleMatch) {
    const [, month, day, year] = singleMatch;
    const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    return { settlementDate: date, contractDate: date, isActive: false };
  }
  
  return { settlementDate: null, contractDate: null, isActive: false };
}

function parseIsoDate(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function parsePrice(price) {
  if (price === null || price === undefined) return 0;
  if (typeof price === 'number') return price;
  if (typeof price === 'string') {
    const cleaned = price.replace(/[$,]/g, '').trim();
    return parseInt(cleaned) || 0;
  }
  return 0;
}

function formatPrice(price) {
  if (!price || price === 0) return 'an undisclosed amount';
  return '$' + price.toLocaleString('en-US');
}

function formatDate(date) {
  if (!date) return 'unknown date';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
}

function titleCase(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

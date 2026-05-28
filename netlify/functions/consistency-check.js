const https = require('https');

exports.handler = async function(event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set in environment variables.' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body.' })
    };
  }

  const { documents } = body;
  if (!documents || documents.length === 0) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'No documents provided.' })
    };
  }

  const SYSTEM_PROMPT = `You are the Appraisal Write-Up Consistency Checker for Nabholz Appraisal Group.

Purpose:
Review uploaded appraisal write-up/order documents after Anna completes the initial report write-up. Identify factual inconsistencies, missing information, and items requiring staff review before the file moves further into production.

Anna runs this check, reviews the output, and resolves what she can. If she cannot resolve an issue, she requests missing information from the client and/or escalates to Amy.

Role limits:
You are not the appraiser, reviewer, lender, underwriter, or final decision-maker. Do not provide value opinions, select comps, review adjustments, perform market analysis, or make legal/title/boundary/ownership/utility conclusions. Your role is factual document comparison only.

Check these categories:

1. Property Identity: address, city, county, ZIP, parcel/APN, legal description, number of parcels, subdivision/lot/block.

2. Assignment Setup: client/lender name, AMC/portal, borrower name, buyer/seller names (purchase), owner name, assignment type, FHA/VA case numbers, due date.

3. Contract / Transaction Data (purchases): contract price, date, buyer/seller names, concessions, personal property, repairs, site size, included/excluded parcels. Unsigned contract = Red Flag. Buyer/seller same last name = Yellow Flag.

4. Site / Parcel / Acreage: reported size vs tax, MLS, contract, survey acreage. Partial conveyance, multi-parcel issues. HIGH PRIORITY.

5. Basic Property Data: year built. HOA fee on MLS but PUD box not checked = Red Flag.

6. Utility Consistency: water/well, sewer/septic. Clear conflict = Red Flag.

7. Agency Setup (FHA/VA/RD): case number match, FHA new construction cert.

8. Seller Name vs Tax Card Owner: close = Yellow Flag, completely different = Red Flag.

9. Rent Schedule: any mention of 1007, investment property, rental income = Yellow Flag.

10. Due Date: lender = 1 business day before lender due date. VA/GP = ~7 business days. Mismatch = Yellow Flag.

11. Report Fee: Conv $600, VA SFR $700, VA mfg $750, VA 2-4 unit $800, GP $550. Outside range = Yellow Flag.

12. GP Orders: missing intended use or intended user = Red Flag.

SEVERITY: Red Flag = stop file | Yellow Flag = Anna reviews | Information Only = useful note | OK = verified | Unable to Verify = source missing.

OUTPUT FORMAT:
DOCUMENTS UPLOADED:
[list each with checkmark or circle]

---
QC RESULT: PASS / REVIEW REQUIRED / STOP - OFFICE REVIEW REQUIRED

Property: [Address]

Summary: [2-3 sentences]

RED FLAGS:
1. [Issue]
   - Source conflict:
   - Recommended action:

YELLOW FLAGS:
1. [Issue]
   - Source conflict:
   - Recommended action:

DISCREPANCY GRID:
| Status | Field | Report Value | Source Value(s) | Issue | Recommended Action |

INFORMATION ONLY:
[bullets]

VERIFIED / OK:
[important items only]

MISSING / UNABLE TO VERIFY:
[bullets with impact]

RECOMMENDED STAFF ACTIONS:
[numbered list]

Be concise. Do not invent data. Show source conflicts. Keep output practical for Anna.`;

  const docLines = documents.map(d => `=== ${d.label.toUpperCase()} ===\n${d.text}`).join('\n\n');
  const userMessage = `Please run the front-end consistency check on the following appraisal write-up packet.\n\n${docLines}`;

  const requestBody = JSON.stringify({
    model: 'claude-3-haiku-20240307',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }]
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(requestBody)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            resolve({
              statusCode: res.statusCode,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ error: `API error ${res.statusCode}: ${JSON.stringify(parsed)}` })
            });
          } else {
            resolve({
              statusCode: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ result: parsed.content[0].text })
            });
          }
        } catch (e) {
          resolve({
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: `Parse error: ${e.message}. Raw: ${data.substring(0, 200)}` })
          });
        }
      });
    });

    req.on('error', (e) => {
      resolve({
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `HTTPS error: ${e.message}` })
      });
    });

    req.setTimeout(25000, () => {
      req.destroy();
      resolve({
        statusCode: 504,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Request timed out after 25 seconds.' })
      });
    });

    req.write(requestBody);
    req.end();
  });
};

const fs = require('fs');

async function exportData() {
  const url = process.env.PUBLIC_SUPABASE_URL || "https://dlklegayibhgnrxnqapm.supabase.co";
  const key = process.env.SUPABASE_SECRET_KEY || "REMOVED_SUPABASE_SERVICE_KEY";
  
  const headers = {
    'apikey': key,
    'Authorization': `Bearer ${key}`
  };

  try {
    console.log("Fetching pacienti...");
    let res = await fetch(`${url}/rest/v1/pacienti?select=*`, { headers });
    const pacienti = await res.json();
    
    console.log("Fetching programari...");
    res = await fetch(`${url}/rest/v1/programari?select=*&order=data.asc,ora.asc`, { headers });
    const programari = await res.json();
    
    console.log("Fetching abonamente...");
    res = await fetch(`${url}/rest/v1/abonamente?select=*&order=created_at.asc`, { headers });
    const abonamente = await res.json();

    let md = "# Patient History Report\n\n";
    md += `Generated on: ${new Date().toLocaleString()}\n\n`;
    
    // Group everything by patient
    for (const p of pacienti) {
      md += `## ${p.nume} ${p.prenume}\n`;
      md += `- **Status:** ${p.status_abonament}\n`;
      md += `- **Plan:** ${p.plan} (${p.frecventa})\n`;
      md += `- **Total Sessions (Profile):** ${p.sedinte_total} | **Used:** ${p.sedinte_folosite} | **Remaining:** ${p.sedinte_ramase}\n`;
      if (p.sters_la) {
        md += `- **Deleted At:** ${p.sters_la}\n`;
      }
      md += "\n";
      
      const p_abonamente = abonamente.filter(a => a.pacient_id === p.id);
      if (p_abonamente.length > 0) {
        md += `### Subscriptions (Abonamente)\n`;
        p_abonamente.forEach(a => {
           md += `- **ID:** ${a.id}\n`;
           md += `  - Status: ${a.status}\n`;
           md += `  - Total Sessions: ${a.nr_sedinte} | Used: ${a.sedinte_folosite}\n`;
           md += `  - Created: ${a.created_at} ${a.closed_at ? '| Closed: ' + a.closed_at : ''}\n`;
        });
        md += "\n";
      }

      const p_programari = programari.filter(pr => pr.pacient_id === p.id);
      if (p_programari.length > 0) {
        md += `### Sessions (Programari)\n`;
        md += `| Date | Time | Status | Location | Counted | Sub. ID |\n`;
        md += `|---|---|---|---|---|---|\n`;
        p_programari.forEach(pr => {
          const subId = pr.abonament_id ? pr.abonament_id.split('-')[0] + '...' : 'None';
          md += `| ${pr.data} | ${pr.ora} | ${pr.status} | ${pr.locatie} | ${pr.contorizeaza} | ${subId} |\n`;
        });
        md += "\n";
      } else {
        md += `*No sessions found.*\n\n`;
      }
      
      md += "---\n\n";
    }
    
    fs.writeFileSync('patient_history.md', md);
    console.log("Wrote patient_history.md successfully.");
  } catch (err) {
    console.error("Error:", err);
  }
}

exportData();

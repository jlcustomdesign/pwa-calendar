const fs = require('fs');

async function exportData() {
  const url = process.env.PUBLIC_SUPABASE_URL || "https://dlklegayibhgnrxnqapm.supabase.co";
  const key = process.env.SUPABASE_SECRET_KEY || "REMOVED_SUPABASE_SERVICE_KEY";
  const userId = 'dd3ea248-e54f-4df1-8101-8b14f782da33';
  
  const headers = {
    'apikey': key,
    'Authorization': `Bearer ${key}`
  };

  try {
    let res = await fetch(`${url}/rest/v1/pacienti?user_id=eq.${userId}&select=*`, { headers });
    const pacienti = await res.json();
    
    res = await fetch(`${url}/rest/v1/programari?user_id=eq.${userId}&select=*&order=data.asc,ora.asc`, { headers });
    const programari = await res.json();
    
    res = await fetch(`${url}/rest/v1/abonamente?user_id=eq.${userId}&select=*&order=created_at.asc`, { headers });
    const abonamente = await res.json();

    let md = "# Patient History Report (kineto@kineto.ro)\n\n";
    md += `Generated on: ${new Date().toLocaleString()}\n\n`;
    
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
        md += `### Subscriptions\n`;
        p_abonamente.forEach(a => {
           md += `- **ID:** ${a.id}\n`;
           md += `  - Status: ${a.status}\n`;
           md += `  - Sessions (Total/Used): ${a.nr_sedinte} / ${a.sedinte_folosite}\n`;
           md += `  - Created: ${new Date(a.created_at).toLocaleDateString()} ${a.closed_at ? '| Closed: ' + new Date(a.closed_at).toLocaleDateString() : ''}\n`;
        });
        md += "\n";
      }

      const p_programari = programari.filter(pr => pr.pacient_id === p.id);
      if (p_programari.length > 0) {
        md += `### Sessions\n`;
        md += `| Date | Time | Status | Location | Counted | Sub. ID |\n`;
        md += `|---|---|---|---|---|---|\n`;
        p_programari.forEach(pr => {
          const subId = pr.abonament_id ? pr.abonament_id.split('-')[0] + '...' : 'None';
          md += `| ${pr.data} | ${pr.ora ? pr.ora.substring(0,5) : ''} | ${pr.status} | ${pr.locatie} | ${pr.contorizeaza} | ${subId} |\n`;
        });
        md += "\n";
      } else {
        md += `*No sessions found.*\n\n`;
      }
      
      md += "---\n\n";
    }
    
    fs.writeFileSync('kineto_patients.md', md);
    console.log("Wrote kineto_patients.md successfully.");
  } catch (err) {
    console.error("Error:", err);
  }
}

exportData();

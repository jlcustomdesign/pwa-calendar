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

    let md = "# Patient Sessions Overview\n\n";
    
    for (const p of pacienti) {
      const p_programari = programari.filter(pr => pr.pacient_id === p.id && (pr.status === 'finalizat' || pr.status === 'absent'));
      
      if (p_programari.length === 0) continue; // Skip patients with no recorded past sessions
      
      const totalPresent = p_programari.filter(pr => pr.status === 'finalizat').length;
      
      md += `## ${p.nume} ${p.prenume}\n`;
      md += `**Total times present:** ${totalPresent}\n\n`;
      
      let currentAbonamentId = p_programari.length > 0 ? p_programari[0].abonament_id : null;
      let sessionCounter = 1;
      
      for (const pr of p_programari) {
        // If the subscription ID changes, reset the counter and add a breaking line
        if (pr.abonament_id !== currentAbonamentId) {
          md += `\n---\n*Subscription Renewed*\n\n`;
          currentAbonamentId = pr.abonament_id;
          sessionCounter = 1; // restart counting for the new subscription
        }
        
        const statusText = pr.status === 'absent' ? ' (Absent)' : '';
        const countedText = pr.contorizeaza === false ? ' (Not counted)' : '';
        md += `- ${pr.data} - Session ${sessionCounter}${statusText}${countedText}\n`;
        
        if (pr.contorizeaza !== false) {
           sessionCounter++;
        }
      }
      
      md += "\n<br/>\n\n";
    }
    
    fs.writeFileSync('kineto_simple.md', md);
    console.log("Wrote kineto_simple.md");
  } catch (err) {
    console.error("Error:", err);
  }
}

exportData();

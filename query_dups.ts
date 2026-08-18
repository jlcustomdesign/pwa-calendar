import { config } from 'dotenv';
config();

const SUPABASE_URL = process.env.PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.PUBLIC_SUPABASE_ANON_KEY;

async function checkDuplicates() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/pacienti?select=nume,prenume,id`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY || '',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY || ''}`,
      }
    });
    
    if (!res.ok) {
        console.error('Failed to fetch:', await res.text());
        return;
    }
    const pacienti = await res.json();
    console.log(`Total patients: ${pacienti.length}`);

    const nameCounts = new Map<string, number>();
    for (const p of pacienti) {
      const fullName = `${p.prenume} ${p.nume}`.trim().toLowerCase();
      nameCounts.set(fullName, (nameCounts.get(fullName) || 0) + 1);
    }

    let dups = 0;
    for (const [name, count] of nameCounts.entries()) {
      if (count > 1) {
        console.log(`Duplicate found: "${name}" occurs ${count} times.`);
        dups++;
      }
    }
    
    if (dups === 0) {
      console.log('No duplicates found in the database.');
    }
  } catch (err) {
    console.error('Error:', err);
  }
}

checkDuplicates();

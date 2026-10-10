const { createClient } = require('@supabase/supabase-js');
const url = process.env.PUBLIC_SUPABASE_URL || "https://dlklegayibhgnrxnqapm.supabase.co";
const key = process.env.SUPABASE_SECRET_KEY || "REMOVED_SUPABASE_SERVICE_KEY";
const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function run() {
  const { data: users, error } = await supabase.auth.admin.listUsers();
  if (error) {
    console.error(error);
    return;
  }
  const target = users.users.find(u => u.email === 'kineto@kineto.ro' || u.email === 'kiento@kineto.ro');
  if (target) {
    console.log("Found user ID:", target.id);
  } else {
    console.log("User not found among:", users.users.map(u => u.email).join(', '));
  }
}
run();

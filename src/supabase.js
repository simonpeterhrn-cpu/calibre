import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

// Cloud sync is only active when keys are configured AND the user signs in.
// All rows are protected by Row Level Security — see supabase-setup.sql.
export const supabase = url && key ? createClient(url, key) : null

/* ====== Bennys configuration - the ONLY file you need to edit ======
   1) SUPABASE_URL  - from Supabase: Settings -> API -> Project URL
   2) SUPABASE_ANON_KEY - Settings -> API -> anon public key
      (the anon key is DESIGNED to be public - your data is protected
       by row-level security, not by hiding this key)
   3) ENABLE_GOOGLE - leave false for launch; flip to true only after
      completing the optional Google sign-in setup in the instructions.
*/
window.BENNYS_CONFIG = {
  SUPABASE_URL: "PASTE_YOUR_SUPABASE_URL_HERE",
  SUPABASE_ANON_KEY: "PASTE_YOUR_ANON_KEY_HERE",
  ENABLE_GOOGLE: false,
  APP_VERSION: "1.0.0"
};

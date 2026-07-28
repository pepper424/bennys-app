/* ====== Bennys configuration - the ONLY file you need to edit ======
   1) SUPABASE_URL  - from Supabase: Settings -> API -> Project URL
   2) SUPABASE_ANON_KEY - Settings -> API -> anon public key
      (the anon key is DESIGNED to be public - your data is protected
       by row-level security, not by hiding this key)
   3) ENABLE_GOOGLE - leave false for launch; flip to true only after
      completing the optional Google sign-in setup in the instructions.
*/
window.BENNYS_CONFIG = {
  SUPABASE_URL: "https://sftrhvrrjgnfglrfkjei.supabase.co/rest/v1/",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNmdHJodnJyamduZmdscmZramVpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4MTMzNjcsImV4cCI6MjEwMDM4OTM2N30.YUGGqYXKxvpnQEdLI3a86m7HCNawQN6CpL5VrtLS2Co",
  ENABLE_GOOGLE: false,
  VAPID_PUBLIC_KEY: "BC4b0tlw47pYLT75LC9lLHsCqDg1-NF7P5nBmrrwZgs_7pSJ0py0TADUrOtg46CGpmfOZyee7BexK0qNkZs1JTw",
  APP_VERSION: "1.0.0"
};

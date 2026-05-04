declare namespace NodeJS {
  interface ProcessEnv {
    JWT_SECRET: string;
    SUPABASE_URL: string;
    SUPABASE_KEY: string;
  }
}

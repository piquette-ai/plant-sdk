declare module "cloudflare:test" {
  interface ProvidedEnv {
    /** Service binding to the hello module Worker, as the router has it. */
    readonly HELLO: Fetcher;
    /** The throwaway subject key the mock core hashes with, hex encoded. The module never gets it. */
    readonly TEST_SUBJECT_KEY: string;
  }
}

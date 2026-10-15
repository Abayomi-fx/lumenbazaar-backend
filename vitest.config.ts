import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      API_HOST: "0.0.0.0",
      API_PORT: "3000",
      API_PUBLIC_URL: "http://localhost:3000",
      CORS_ALLOWED_ORIGINS: "http://localhost:3000,https://lumenbazaar-frontend.vercel.app",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/lumenbazaar_test",
      DEFAULT_ASSET_CODE: "USDC",
      ENABLE_UPTO_SCHEME: "false",
      EVENT_STREAM_SIGNING_SECRET: "lumenbazaar-test-event-stream-signing-secret",
      FACILITATOR_ACCOUNT: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      LUMEN_ENV: "local",
      REDIS_URL: "redis://localhost:6379",
      STELLAR_PUBNET_HORIZON_URL: "https://horizon.stellar.org",
      STELLAR_PUBNET_RPC_URL: "https://mainnet.sorobanrpc.com",
      STELLAR_PUBNET_UPTO_SESSION_CONTRACT_ID: "",
      STELLAR_PUBNET_USDC_CONTRACT_ID: "",
      STELLAR_PUBNET_USDC_ISSUER: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      STELLAR_TESTNET_HORIZON_URL: "https://horizon-testnet.stellar.org",
      STELLAR_TESTNET_RPC_URL: "https://soroban-testnet.stellar.org",
      STELLAR_TESTNET_UPTO_SESSION_CONTRACT_ID: "",
      STELLAR_TESTNET_USDC_CONTRACT_ID: "",
      STELLAR_TESTNET_USDC_ISSUER: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
    }
  }
});

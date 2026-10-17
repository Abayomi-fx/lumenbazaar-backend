import {
  createEd25519Signer,
  isFacilitatorStellarSigner,
  type FacilitatorStellarSigner
} from "@x402/stellar";

import {
  LumenError,
  listConfiguredNetworks,
  type AppConfig,
  type NetworkId
} from "@lumenbazaar/shared";

export type SignerSecretSnapshot = {
  secret: string;
  version: string;
};

export type SignerStatus = {
  address: string;
  keyVersion: string;
  network: NetworkId;
  provider: "environment";
};

export type FacilitatorSignerProvider = {
  assertReady(): Promise<void>;
  getSigner(): Promise<FacilitatorStellarSigner>;
  getStatus(): Promise<SignerStatus>;
};

export type EnvironmentFacilitatorSignerOptions = {
  expectedAddress: string;
  network: NetworkId;
  readSecret: () => SignerSecretSnapshot | Promise<SignerSecretSnapshot>;
};

type CachedSigner = {
  signer: FacilitatorStellarSigner;
  version: string;
};

export class EnvironmentFacilitatorSignerProvider implements FacilitatorSignerProvider {
  private cached: CachedSigner | undefined;
  private revoked = false;

  constructor(private readonly options: EnvironmentFacilitatorSignerOptions) {}

  async assertReady(): Promise<void> {
    await this.getSigner();
  }

  async getSigner(): Promise<FacilitatorStellarSigner> {
    if (this.revoked) {
      throw signerUnavailable("Facilitator signer has been revoked.");
    }

    const snapshot = await this.readSnapshot();
    if (this.cached?.version === snapshot.version) {
      return this.cached.signer;
    }

    let signer: FacilitatorStellarSigner;
    try {
      signer = createEd25519Signer(snapshot.secret, this.options.network);
    } catch {
      throw signerUnavailable("Facilitator signing material is invalid.");
    }

    if (!isFacilitatorStellarSigner(signer)) {
      throw signerUnavailable("Facilitator signer does not implement the required interface.");
    }
    if (signer.address !== this.options.expectedAddress) {
      throw signerUnavailable("Facilitator signer address does not match configuration.");
    }

    this.cached = { signer, version: snapshot.version };
    return signer;
  }

  async getStatus(): Promise<SignerStatus> {
    const signer = await this.getSigner();
    return {
      address: signer.address,
      keyVersion: this.cached?.version ?? "unknown",
      network: this.options.network,
      provider: "environment"
    };
  }

  rotate(): void {
    this.cached = undefined;
  }

  revoke(): void {
    this.revoked = true;
    this.cached = undefined;
  }

  restore(): void {
    this.revoked = false;
    this.cached = undefined;
  }

  private async readSnapshot(): Promise<SignerSecretSnapshot> {
    let snapshot: SignerSecretSnapshot;
    try {
      snapshot = await this.options.readSecret();
    } catch {
      throw signerUnavailable("Facilitator signing material is unavailable.");
    }

    if (snapshot.secret.length === 0 || snapshot.version.length === 0) {
      throw signerUnavailable("Facilitator signing material is unavailable.");
    }
    return snapshot;
  }
}

export function createRuntimeFacilitatorSignerProvider(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env
): FacilitatorSignerProvider | undefined {
  if (config.signer.provider === "disabled") {
    return undefined;
  }

  const activeNetwork = listConfiguredNetworks(config)[0]?.id;
  if (activeNetwork === undefined || config.signer.network !== activeNetwork) {
    throw signerUnavailable("Facilitator signer network does not match the active network.");
  }

  return new EnvironmentFacilitatorSignerProvider({
    expectedAddress: config.facilitatorAccount,
    network: config.signer.network,
    readSecret: () => ({
      secret: environment.FACILITATOR_SIGNING_KEY ?? "",
      version: environment.FACILITATOR_SIGNING_KEY_VERSION ?? config.signer.keyVersion ?? ""
    })
  });
}

export async function assertRuntimeSignerReady(
  provider: FacilitatorSignerProvider | undefined
): Promise<void> {
  await provider?.assertReady();
}

function signerUnavailable(message: string) {
  return new LumenError("SETTLEMENT_FAILED", message, {
    details: { component: "facilitator_signer" }
  });
}

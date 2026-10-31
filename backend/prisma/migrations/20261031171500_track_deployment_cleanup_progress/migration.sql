-- Track per-resource cleanup progress so partial cleanup can be retried and audited.
ALTER TABLE "ComposeEnvironment"
    ADD COLUMN "deploymentRemovedContainerIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "deploymentRemovedNetworkIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

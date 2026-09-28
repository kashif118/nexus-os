-- A top-level folder has a NULL parentId, and Postgres treats NULLs as
-- distinct, so `@@unique([organizationId, parentId, name])` does not stop two
-- root folders sharing a name. A partial unique index covers exactly that case.
--
-- Expressed as raw SQL because Prisma has no syntax for a partial index; the
-- integration test asserts the behaviour so the two cannot drift silently.
CREATE UNIQUE INDEX "Folder_organizationId_name_root_key"
  ON "Folder" ("organizationId", "name")
  WHERE "parentId" IS NULL AND "deletedAt" IS NULL;

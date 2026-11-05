-- AlterTable
ALTER TABLE "establishment_rules" ADD COLUMN     "maxDependientasManana" INTEGER NOT NULL DEFAULT 99,
ADD COLUMN     "maxDependientasTarde" INTEGER NOT NULL DEFAULT 99,
ADD COLUMN     "maxElaboracionManana" INTEGER NOT NULL DEFAULT 99,
ADD COLUMN     "maxElaboracionTarde" INTEGER NOT NULL DEFAULT 99;

-- CreateEnum
CREATE TYPE "Rol" AS ENUM ('EMPLEADO', 'MANAGER_LOCAL', 'MANAGER_GENERAL');

-- CreateEnum
CREATE TYPE "TurnoTipo" AS ENUM ('MANANA', 'TARDE', 'PARTIDO', 'LIBRE');

-- CreateEnum
CREATE TYPE "Flexibilidad" AS ENUM ('ALTA', 'MEDIA', 'BAJA');

-- CreateEnum
CREATE TYPE "OrigenPreferencia" AS ENUM ('WHATSAPP', 'MANUAL');

-- CreateEnum
CREATE TYPE "DiaSemana" AS ENUM ('LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO');

-- CreateEnum
CREATE TYPE "EstadoConversacion" AS ENUM ('PENDIENTE', 'EN_PROGRESO', 'COMPLETADO');

-- CreateTable
CREATE TABLE "establishments" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "direccion" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "managerLocalId" INTEGER,

    CONSTRAINT "establishments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "apellidos" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT,
    "telefonoWhatsapp" TEXT,
    "rol" "Rol" NOT NULL DEFAULT 'EMPLEADO',
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "flexible" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "establecimientoId" INTEGER,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_establishments" (
    "employeeId" INTEGER NOT NULL,
    "establishmentId" INTEGER NOT NULL,
    "asignadoPor" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_establishments_pkey" PRIMARY KEY ("employeeId","establishmentId")
);

-- CreateTable
CREATE TABLE "shift_preferences" (
    "id" SERIAL NOT NULL,
    "semana" TEXT NOT NULL,
    "turnoPreferido" "TurnoTipo",
    "diasNoDisponible" TEXT[],
    "maxHorasSemana" INTEGER,
    "flexibilidad" "Flexibilidad" NOT NULL DEFAULT 'MEDIA',
    "notasAdicionales" TEXT,
    "recogidoVia" "OrigenPreferencia" NOT NULL DEFAULT 'WHATSAPP',
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "fechaActualizacion" TIMESTAMP(3) NOT NULL,
    "empleadoId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_rules" (
    "id" SERIAL NOT NULL,
    "semana" TEXT NOT NULL,
    "minEmpleadosManana" INTEGER NOT NULL DEFAULT 2,
    "minEmpleadosTarde" INTEGER NOT NULL DEFAULT 2,
    "maxDiasConsecutivos" INTEGER NOT NULL DEFAULT 5,
    "horasDescansoMinimoEntreTurnos" INTEGER NOT NULL DEFAULT 12,
    "reglasAdicionalesTexto" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "establecimientoId" INTEGER,
    "creadoPorId" INTEGER NOT NULL,

    CONSTRAINT "weekly_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" SERIAL NOT NULL,
    "semana" TEXT NOT NULL,
    "dia" "DiaSemana" NOT NULL,
    "turno" "TurnoTipo" NOT NULL,
    "horaInicio" TEXT,
    "horaFin" TEXT,
    "generadoPorIa" BOOLEAN NOT NULL DEFAULT false,
    "ajustadoPorManager" BOOLEAN NOT NULL DEFAULT false,
    "publicado" BOOLEAN NOT NULL DEFAULT false,
    "conflicto" BOOLEAN NOT NULL DEFAULT false,
    "notaConflicto" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "empleadoId" INTEGER NOT NULL,
    "establecimientoId" INTEGER NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_conversations" (
    "id" SERIAL NOT NULL,
    "telefono" TEXT NOT NULL,
    "semana" TEXT NOT NULL,
    "estado" "EstadoConversacion" NOT NULL DEFAULT 'PENDIENTE',
    "paso" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_messages" (
    "id" SERIAL NOT NULL,
    "direccion" TEXT NOT NULL,
    "contenido" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "conversacionId" INTEGER NOT NULL,

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employees_email_key" ON "employees"("email");

-- CreateIndex
CREATE UNIQUE INDEX "employees_telefonoWhatsapp_key" ON "employees"("telefonoWhatsapp");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_conversations_telefono_key" ON "whatsapp_conversations"("telefono");

-- AddForeignKey
ALTER TABLE "establishments" ADD CONSTRAINT "establishments_managerLocalId_fkey" FOREIGN KEY ("managerLocalId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_establecimientoId_fkey" FOREIGN KEY ("establecimientoId") REFERENCES "establishments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_establishments" ADD CONSTRAINT "employee_establishments_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_establishments" ADD CONSTRAINT "employee_establishments_establishmentId_fkey" FOREIGN KEY ("establishmentId") REFERENCES "establishments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_preferences" ADD CONSTRAINT "shift_preferences_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_rules" ADD CONSTRAINT "weekly_rules_establecimientoId_fkey" FOREIGN KEY ("establecimientoId") REFERENCES "establishments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_rules" ADD CONSTRAINT "weekly_rules_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_establecimientoId_fkey" FOREIGN KEY ("establecimientoId") REFERENCES "establishments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_conversacionId_fkey" FOREIGN KEY ("conversacionId") REFERENCES "whatsapp_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

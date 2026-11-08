import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../services/prisma.js';

export async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña requeridos' });
  }

  const employee = await prisma.employee.findUnique({ where: { email } });
  if (!employee || !employee.passwordHash) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }
  if (employee.rol === 'EMPLEADO') {
    return res.status(403).json({ error: 'Els treballadors accedeixen per WhatsApp' });
  }

  const valid = await bcrypt.compare(password, employee.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  // For manager_local, include their establishment IDs in the token
  let establecimientos = [];
  if (employee.rol === 'MANAGER_LOCAL') {
    const managed = await prisma.establishment.findMany({
      where: { managerLocalId: employee.id },
      select: { id: true },
    });
    establecimientos = managed.map((e) => e.id);
  }

  const token = jwt.sign(
    {
      id: employee.id,
      email: employee.email,
      nombre: employee.nombre,
      rol: employee.rol,
      establecimientos,
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  return res.json({
    token,
    user: {
      id: employee.id,
      nombre: employee.nombre,
      apellidos: employee.apellidos,
      email: employee.email,
      rol: employee.rol,
      establecimientos,
    },
  });
}

export function logout(_req, res) {
  // JWT is stateless — client simply discards the token
  return res.json({ mensaje: 'Sesión cerrada' });
}

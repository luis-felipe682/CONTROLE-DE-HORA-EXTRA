const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');

const app = express();
app.use(cors());
app.use(express.json());

const db = new Database('database.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS usuario (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cargo TEXT NOT NULL,
    salario REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lancamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    horaInicio TEXT NOT NULL,
    horaFim TEXT NOT NULL,
    porcentagem INTEGER NOT NULL,
    totalHoras REAL NOT NULL,
    justificativa TEXT NOT NULL
  );
`);

// Função para calcular horas normais e noturnas (entre 22h e 5h)
function calcularHorasDetalhadas(inicio, fim) {
  const [h1, m1] = inicio.split(':').map(Number);
  const [h2, m2] = fim.split(':').map(Number);

  let inicioMin = h1 * 60 + m1;
  let fimMin = h2 * 60 + m2;

  if (fimMin <= inicioMin) {
    fimMin += 24 * 60; // Virada de dia
  }

  let minutosDiurnos = 0;
  let minutosNoturnos = 0;

  for (let m = inicioMin; m < fimMin; m++) {
    let horaDoDia = Math.floor((m % (24 * 60)) / 60);
    if (horaDoDia >= 22 || horaDoDia < 5) {
      minutosNoturnos++;
    } else {
      minutosDiurnos++;
    }
  }

  const horasDiurnas = minutosDiurnos / 60;
  // Aplica a hora reduzida noturna da CLT (60 / 52.5 = 1.142857)
  const horasNoturnas = (minutosNoturnos / 60) * 1.142857;

  return {
    horasDiurnas,
    horasNoturnas,
    totalHorasComputadas: horasDiurnas + horasNoturnas
  };
}

// Rota: Buscar usuário
app.get('/api/usuario', (req, res) => {
  const usuario = db.prepare('SELECT * FROM usuario ORDER BY id DESC LIMIT 1').get();
  if (!usuario) return res.json(null);
  const valorHoraNormal = usuario.salario / 220;
  res.json({ ...usuario, valorHoraNormal });
});

// Rota: Cadastrar usuário
app.post('/api/usuario', (req, res) => {
  const { nome, cargo, salario } = req.body;
  if (!nome || !cargo || !salario) return res.status(400).json({ error: 'Campos obrigatórios.' });

  const salarioNum = parseFloat(salario);
  db.prepare('DELETE FROM usuario').run();
  const stmt = db.prepare('INSERT INTO usuario (nome, cargo, salario) VALUES (?, ?, ?)');
  stmt.run(nome, cargo, salarioNum);

  res.status(201).json({ nome, cargo, salario: salarioNum });
});

// Rota: Listar lançamentos com Filtro, Adicional Noturno e DSR
app.get('/api/lancamentos', (req, res) => {
  const usuario = db.prepare('SELECT * FROM usuario ORDER BY id DESC LIMIT 1').get();
  if (!usuario) return res.status(400).json({ error: 'Cadastre o usuário primeiro' });

  const { mesAno } = req.query; // Exemplo de formato: "2026-09"
  let query = 'SELECT * FROM lancamentos';
  let params = [];

  if (mesAno) {
    query += ' WHERE data LIKE ?';
    params.push(`${mesAno}%`);
  }
  query += ' ORDER BY data DESC, id DESC';

  const lista = db.prepare(query).all(...params);
  const valorHoraNormal = usuario.salario / 220;

  let totalHoras = 0;
  let totalReceberHE = 0;

  const listaCalculada = lista.map(l => {
    const detalhe = calcularHorasDetalhadas(l.horaInicio, l.horaFim);
    const multiplicadorHE = 1 + (l.porcentagem / 100);

    const valorHoraDiurna = valorHoraNormal * multiplicadorHE;
    // Adicional Noturno adiciona 20% sobre a hora base
    const valorHoraNoturna = (valorHoraNormal * 1.20) * multiplicadorHE;

    const valorTotalDiurno = detalhe.horasDiurnas * valorHoraDiurna;
    const valorTotalNoturno = detalhe.horasNoturnas * valorHoraNoturna;
    const valorTotalItem = valorTotalDiurno + valorTotalNoturno;

    totalHoras += detalhe.totalHorasComputadas;
    totalReceberHE += valorTotalItem;

    return {
      ...l,
      horasDiurnas: detalhe.horasDiurnas,
      horasNoturnas: detalhe.horasNoturnas,
      totalHoras: detalhe.totalHorasComputadas,
      valorTotalItem
    };
  });

  // Cálculo Estimado de DSR (Considerando 22 dias úteis e 4 domingos/feriados como padrão)
  const valorDSR = (totalReceberHE / 22) * 4;
  const totalGeral = totalReceberHE + valorDSR;

  res.json({
    usuario: { ...usuario, valorHoraNormal },
    lancamentos: listaCalculada,
    resumo: {
      totalHoras,
      valorHoraNormal,
      totalReceberHE,
      valorDSR,
      totalGeral
    }
  });
});

// Rota: Criar lançamento
app.post('/api/lancamentos', (req, res) => {
  const { data, horaInicio, horaFim, porcentagem, justificativa } = req.body;
  const detalhe = calcularHorasDetalhadas(horaInicio, horaFim);

  const stmt = db.prepare(`
    INSERT INTO lancamentos (data, horaInicio, horaFim, porcentagem, totalHoras, justificativa)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(data, horaInicio, horaFim, parseInt(porcentagem), detalhe.totalHorasComputadas, justificativa);
  res.status(201).json({ id: info.lastInsertRowid });
});

// Rota: Editar lançamento
app.put('/api/lancamentos/:id', (req, res) => {
  const { id } = req.params;
  const { data, horaInicio, horaFim, porcentagem, justificativa } = req.body;
  const detalhe = calcularHorasDetalhadas(horaInicio, horaFim);

  const stmt = db.prepare(`
    UPDATE lancamentos SET data = ?, horaInicio = ?, horaFim = ?, porcentagem = ?, totalHoras = ?, justificativa = ? WHERE id = ?
  `);
  stmt.run(data, horaInicio, horaFim, parseInt(porcentagem), detalhe.totalHorasComputadas, justificativa, id);
  res.json({ message: 'Atualizado com sucesso.' });
});

// Rota: Excluir lançamento
app.delete('/api/lancamentos/:id', (req, res) => {
  db.prepare('DELETE FROM lancamentos WHERE id = ?').run(req.params.id);
  res.json({ message: 'Excluído com sucesso.' });
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));
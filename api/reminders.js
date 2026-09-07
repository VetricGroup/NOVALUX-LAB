function redis(command, args) {
  return fetch(`${process.env.UPSTASH_REDIS_REST_URL}/${command}/${args.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  }).then(async response => {
    if (!response.ok) throw new Error(`Redis respondió ${response.status}`);
    return (await response.json()).result;
  });
}

function tomorrowInCostaRica() {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Costa_Rica' }).format(date);
}

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).end();
  try {
    const ids = await redis('smembers', ['novalux:bookings']);
    const bookings = await Promise.all((ids || []).map(id => redis('get', [`novalux:booking:${id}`])));
    const targetDate = tomorrowInCostaRica();
    for (const booking of bookings.filter(Boolean)) {
      if (booking.date !== targetDate || booking.reminderSent) continue;
      if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID || !process.env.WHATSAPP_TEMPLATE_NAME) throw new Error('WhatsApp no está configurado');
      const response = await fetch(`https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp', to: booking.phone.replace(/[^\d]/g, ''),
          type: 'template', template: { name: process.env.WHATSAPP_TEMPLATE_NAME, language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'es' }, components: [{ type: 'body', parameters: [{ type: 'text', text: booking.name }, { type: 'text', text: booking.date }, { type: 'text', text: booking.time }] }] }
        })
      });
      if (!response.ok) throw new Error('WhatsApp rechazó el recordatorio');
      booking.reminderSent = true;
      await redis('set', [`novalux:booking:${booking.id}`, JSON.stringify(booking)]);
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('reminder_error', error);
    return res.status(500).json({ error: 'No se pudieron procesar los recordatorios.' });
  }
};

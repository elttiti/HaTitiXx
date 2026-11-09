(() => {
    'use strict';
    // Agrega códigos dentro de `codes`; el canje admite objetos, modos y puntos.
    // Los canjes quedan guardados localmente en este dispositivo.
    const normalize = (value) => String(value ?? '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .trim().toLocaleLowerCase('es').replace(/\s+/g, ' ');
    const codes = Object.freeze({
        'polo dame leche': Object.freeze({
            id: 'polo-dame-leche',
            reward: Object.freeze({ type: 'shop-item', itemId: 'fx-lechazo' }),
            message: 'Explosión Lechazo gratis desbloqueada. La moneda ahora se llama Titipoints.'
        }),
        'pasitos': Object.freeze({
            id: 'pasitos',
            reward: Object.freeze({ type: 'unlock-mode', modeId: 'pasitos' }),
            message: 'Modo Pasitos desbloqueado. Puedes activarlo o desactivarlo en Ajustes → Personalización.'
        }),
        'gracias_por_usar_haxtitix': Object.freeze({
            id: 'gracias-por-usar-haxtitix',
            reward: Object.freeze({ type: 'points', amount: 100 }),
            message: '¡Gracias por usar HaTitix! Se agregaron 100 Titipoints.'
        })
    });
    window.HATITIX_PROMO_CODES = Object.freeze({ normalize, codes });
})();

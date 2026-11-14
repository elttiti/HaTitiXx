(() => {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const address = $('address');
    const perform = async (action, value) => {
        try { await window.workshopBrowser.action(action, value); }
        catch (error) { $('hint').textContent = error?.message || 'No se pudo completar la acción.'; }
    };
    $('back').addEventListener('click', () => perform('back'));
    $('forward').addEventListener('click', () => perform('forward'));
    $('reload').addEventListener('click', () => perform('reload'));
    $('close').addEventListener('click', () => perform('close'));
    $('go').addEventListener('click', () => perform('navigate', address.value.trim()));
    address.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); perform('navigate', address.value.trim()); }
    });
    window.workshopBrowser.onState((state) => {
        if (!state) return;
        if (state.url && document.activeElement !== address) address.value = state.url;
        $('back').disabled = !state.canGoBack;
        $('forward').disabled = !state.canGoForward;
        $('hint').textContent = state.loading ? 'Cargando…' : (state.title || 'Navegador integrado de HaTitix');
    });
})();

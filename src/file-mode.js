if (window.location.protocol === 'file:') {
  const warning = document.querySelector('#file-mode-warning');
  if (warning) warning.hidden = false;
}


// Label role dipakai di banyak tempat (sidebar, halaman admin).
export const ROLE_LABEL = {
  owner: 'Pemilik', admin: 'Administrator', manager: 'Manajer',
  inventory: 'Manajer Inventaris', cashier: 'Kasir',
};
export const roleLabel = (r) => ROLE_LABEL[r] || r || 'Anggota tim';

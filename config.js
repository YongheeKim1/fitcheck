// Supabase 연결 정보 (Supabase 대시보드 → Project Settings → API Keys의 Publishable key)
// publishable(anon) 키는 브라우저에 공개돼도 되는 키예요. 테이블은 모두 잠겨 있고 fc_* 함수만 호출할 수 있어요.
// service_role(secret) 키는 절대 여기에 넣지 마세요.
window.FITCHECK_CONFIG = {
  supabaseUrl: 'https://jttvcqacanpfausaryzs.supabase.co',
  supabaseAnonKey: 'sb_publishable_2cb8JvD6IF-VK_VEp-DSCw_VUDhQunf',
};

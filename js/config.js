/* 앱 설정값 (모두 공개되어도 되는 값) */
window.RS_CONFIG = {
  // Google Cloud 프로젝트 nkmro-receipt-scan 의 OAuth 클라이언트 ID
  googleClientId: '727664895919-9iutne7dg3kjhi79llaa4lfjsgi2u4io.apps.googleusercontent.com',
  // 중계 서버(Cloud Run) 주소. 배포 후 채움
  relayUrl: 'https://receipt-scan-relay-727664895919.asia-northeast3.run.app',
  // profile = Google 계정 이름(승인 화면에서 누구인지 알아보기 위함)
  scopes: 'openid email profile https://www.googleapis.com/auth/drive.file'
};

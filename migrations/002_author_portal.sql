-- 002_author_portal.sql

-- USERS TABLE UPDATE
ALTER TABLE users
ADD COLUMN role TEXT NOT NULL DEFAULT 'CUSTOMER';

ALTER TABLE users
ADD COLUMN last_reauth_at TIMESTAMPTZ;

CREATE INDEX idx_users_role ON users(role);

-- AUTHOR POSTS
CREATE TABLE author_posts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,

  excerpt TEXT,
  body_markdown TEXT NOT NULL,
  body_html TEXT, -- optional cache

  visibility TEXT NOT NULL, -- IN_APP_ANNOUNCEMENT | CHANGELOG | DOC_PAGE
  status TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT | SCHEDULED | PUBLISHED | ARCHIVED

  tags TEXT[] DEFAULT '{}',

  cover_image_url TEXT,
  cta_text TEXT,
  cta_url TEXT,

  seo_title TEXT,
  seo_description TEXT,

  scheduled_publish_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,

  created_by_user_id UUID NOT NULL REFERENCES users(id),
  updated_by_user_id UUID NOT NULL REFERENCES users(id),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_author_posts_status ON author_posts(status);
CREATE INDEX idx_author_posts_visibility ON author_posts(visibility);
CREATE INDEX idx_author_posts_published_at ON author_posts(published_at);


-- POST REVISIONS
CREATE TABLE author_post_revisions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  post_id UUID NOT NULL REFERENCES author_posts(id) ON DELETE CASCADE,

  title TEXT NOT NULL,
  excerpt TEXT,
  body_markdown TEXT NOT NULL,

  updated_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_author_post_revisions_post_id ON author_post_revisions(post_id);


-- APP BANNER (SINGLE ROW TABLE)
CREATE TABLE app_banner (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  enabled BOOLEAN NOT NULL DEFAULT false,
  message TEXT,
  severity TEXT NOT NULL DEFAULT 'INFO', -- INFO | WARNING | CRITICAL
  link_text TEXT,
  link_url TEXT,

  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,

  updated_by_user_id UUID NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- AUTHOR AUDIT LOG
CREATE TABLE author_audit (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  actor_user_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL, -- AUTHOR_LOGIN_SUCCESS | AUTHOR_LOGIN_FAIL | POST_CREATE | POST_UPDATE | POST_PUBLISH | POST_SCHEDULE | POST_ARCHIVE | BANNER_UPDATE

  target_type TEXT, -- POST | BANNER
  target_id UUID,
  diff_json JSONB
);

CREATE INDEX idx_author_audit_created_at ON author_audit(created_at);
CREATE INDEX idx_author_audit_actor_user_id ON author_audit(actor_user_id);

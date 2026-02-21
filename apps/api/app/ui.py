from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from app.dependencies import get_db, get_job_service, resolve_settings
from app.jobs import JobService
from tm_core.capabilities import list_capabilities


templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))
router = APIRouter(tags=["ui"])


@router.get("/", response_class=HTMLResponse)
def home() -> RedirectResponse:
    return RedirectResponse(url="/jobs", status_code=302)


@router.get("/settings", response_class=HTMLResponse)
def settings_page(request: Request, settings=Depends(resolve_settings), db=Depends(get_db)) -> HTMLResponse:
    keys = {item["provider"]: item for item in db.list_api_keys()}
    providers = list_capabilities(app_mode=settings.app_mode)["providers"]
    return templates.TemplateResponse(
        request=request,
        name="settings.html",
        context={
            "app_mode": settings.app_mode,
            "providers": providers,
            "keys": keys,
            "fallback_order": settings.fallback_order,
            "sync_size_threshold_mb": settings.sync_size_threshold_mb,
            "retention_days": settings.retention_days,
            "allowlist": settings.local_folder_allowlist,
        },
    )


@router.get("/jobs", response_class=HTMLResponse)
def jobs_page(request: Request, service: JobService = Depends(get_job_service)) -> HTMLResponse:
    jobs = service.list_jobs(limit=100)
    return templates.TemplateResponse(request=request, name="jobs.html", context={"jobs": jobs})


@router.get("/jobs/new", response_class=HTMLResponse)
def new_job_page(request: Request, settings=Depends(resolve_settings)) -> HTMLResponse:
    capabilities = list_capabilities(app_mode=settings.app_mode)
    return templates.TemplateResponse(
        request=request,
        name="job_new.html",
        context={
            "app_mode": settings.app_mode,
            "capabilities": capabilities,
            "fallback_order": settings.fallback_order,
        },
    )


@router.get("/jobs/{job_id}", response_class=HTMLResponse)
def job_detail_page(request: Request, job_id: str, service: JobService = Depends(get_job_service)) -> HTMLResponse:
    job = service.get_job(job_id)
    return templates.TemplateResponse(request=request, name="job_detail.html", context={"job": job})
